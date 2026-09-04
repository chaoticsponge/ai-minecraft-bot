# AI Mineflayer assistant

A Minecraft Java Edition 1.21.11 assistant bot. A local language model plans
high-level actions, while deterministic Mineflayer code validates and executes
movement, following, collection, crafting, placement, combat, equipment, eating,
fallen-item pickup, dropping/giving items, chat, and waiting.

## Configured services

- Minecraft: `localhost:49615`, version `1.21.11`
- AI: `http://127.0.0.1:8080/v1`
- AI model: `gemma-4-26b-a4b-it`

The local AI service must be running before a player submits an AI goal.

## Run

```bash
npm install
npm start
```

The included `.env` contains the local defaults. It is ignored by git. If the
Minecraft server has `online-mode=true`, change these entries and complete the
Microsoft device login shown on first startup:

```dotenv
MC_AUTH=microsoft
MC_USERNAME=your-account-email@example.com
```

## In-game whisper commands

```text
/w MineflayerBot help
/w MineflayerBot follow Steve
/w MineflayerBot guard me
/w MineflayerBot kill the nearest zombie
/w MineflayerBot collect 16 oak logs
/w MineflayerBot create a strip mine here and get 30 diamonds
/w MineflayerBot continue the strip mine
/w MineflayerBot extend the strip mine by 120 blocks for diamonds
/w MineflayerBot make a stairway to diamond level
/w MineflayerBot collect the materials for the starter home
/w MineflayerBot build the starter home here
/w MineflayerBot put 32 cobblestone in the nearest chest
/w MineflayerBot take 16 torches from the chest
/w MineflayerBot mine that block
/w MineflayerBot open that chest
/w MineflayerBot attack that mob
/w MineflayerBot this is my home
/w MineflayerBot go home
/w MineflayerBot return to the surface
/w MineflayerBot create a wheat farm here
/w MineflayerBot harvest and replant wheat
/w MineflayerBot sleep
/w MineflayerBot status
/w MineflayerBot stop
```

The bot ignores public chat and all players except `KawaiiSponge`. Every whisper
from that player is treated as a direct instruction, with no `!ai` prefix. A
whispered `stop` is an immediate interrupt. A new goal cancels and replaces the
current goal instead of waiting for it. Accepted goals receive one private
`Got it.` acknowledgement; internal planning and switching messages are hidden.

## Planner/controller architecture

Gemma is an event-driven planner, not a per-tick driver. One inference returns a
batch of high-level actions plus a deterministic completion condition. Mineflayer
then performs navigation, digging, tool selection, crafting, eating, and combat
without additional model calls between actions.

A conservative local intent catalogue bypasses Gemma entirely for high-confidence
commands: item quantities, tool crafting and tool sets, ore quantities, following,
staircases to explicit Y or named resource levels, fixed and continued strip mines,
combined strip-mine/resource goals, item pickup/drop/give, eating,
guarding, visible hostile targeting, known local schematics, greetings, thanks,
and basic capability questions. These plans pass through the exact same schema and
safety checks as AI plans. Anything conversational or ambiguous still goes to
Gemma. This keeps routine commands responsive even with slow token generation.
“Continue the strip mine” creates a bounded 64-block deterministic segment in
the direction the bot is facing. A stated block count overrides that default,
and an optional resource name limits opportunistic ore collection to that family.

The controller fingerprints failed actions together with position, health,
hunger, and aggregated inventory. If Gemma returns the exact same failed action
without any observable world progress, execution is rejected immediately and the
planner receives a `repeated_action` event asking for a different target,
direction, or approach. This prevents expensive identical failure loops while
still allowing a retry after the world or inventory changes.

The controller asks Gemma for another plan only after the whole batch fails or
finishes without satisfying its completion condition. A task tree tracks the
active high-level action and recursive subtask. Damage, hunger, hostiles,
drowning, lava, fire, and dangerous falls pre-empt that task, run deterministic
survival behavior, then resume the interrupted action without another inference.
These checks remain active while idle or while Gemma is planning. Successful
planning is capped by `MAX_PLANS_PER_GOAL`. After
`MAX_CONSECUTIVE_AI_FAILURES` timeouts or service errors, the controller pauses,
keeps the goal checkpoint, and privately tells the player instead of retrying
forever. A plain `resume`, `continue`, `carry on`, or `keep going` resumes that
exact checkpoint once the model is available.

A modular selection manager provides the Player2NPC-style crosshair context.
For short references such as `mine that block`, `open that chest`, or
`attack that mob`, it ray-samples from the requesting player's eyes and compiles
the result locally without calling Gemma. Block actions retain the exact selected
coordinates, entity selection uses the entity hitbox, and a solid selected block
occludes entities behind it. Selected containers are inspected, cached, and
closed immediately rather than leaving a window open.

If a live task cannot obtain required equipment such as a pickaxe, axe, shovel,
hoe, crafting table, furnace, shield, or water bucket, the controller does not
leave the failure only in the terminal. It privately tells the requesting player
what is missing and its current coordinates, attempts to walk to that player
when they are visible and safely reachable, and waits up to
`EQUIPMENT_REQUEST_WAIT_MS` (60 seconds by default). Matching dropped equipment
is picked up automatically. Once a usable item arrives, the failed checkpointed
action resumes without another Gemma inference. Repeated identical requests are
suppressed, while `stop`, replacement goals, and survival interrupts remain
immediate.

If the local AI endpoint times out or produces an invalid plan, the controller
keeps the current checkpoint and retries with an interruptible 2–60 second
exponential backoff. Status whispers report the retry delay, and `stop` or a new
instruction still takes effect immediately. Failed AI calls do not consume the
successful-plan limit.

Active goals are checkpointed after every high-level action and during long
collection, recipe, mining, and building subtasks. A disconnect or
memory-guard reconnect resumes at the interrupted action. Idempotent execution
reuses items already gathered or crafted and blocks already placed instead of
blindly repeating them. A
player-issued `stop` or replacement goal clears the checkpoint.
Persistent follow plans remain active and checkpointed until interrupted, rather
than being treated as a completed one-shot action.

Death records the bot's position, dimension, and carried item names in the active
checkpoint. After respawn it returns when the location is within the configured
movement limit and no hostile is guarding it, gathers matching nearby drops, and
then resumes the interrupted action. If the process disconnects during recovery,
that recovery record remains available on reconnect.

Environmental escape is target-aware: lava recovery looks for nearby dry,
two-block-high footing instead of running in the current facing direction, and
drowning recovery swims toward a detected air space or safely clears a diggable
ceiling when trapped. Ranged attackers are detected farther away than melee mobs.
Conditionally neutral endermen, spiders, and zombified piglins do not interrupt
normal work merely by standing nearby, but are considered after serious damage.
After leaving lava, the monitor gives ordinary residual flames 1.5 seconds to
expire before interrupting work. Persistent fire uses a carried water bucket or
heads toward nearby water; critical health bypasses the grace period.
The monitor also detects a solid block intersecting the bot's head. Suffocation
pre-empts idle work, planning, or execution and repeatedly digs the obstructing
column for up to eight seconds, which lets it escape collapsing sand or gravel;
it refuses to loop against an unbreakable block.

The included `.env` sets `ALLOWED_USERS=KawaiiSponge`, so other players cannot
submit goals. Multiple authorized names can be comma-separated if needed later.

## Safety boundaries

The language model can only return a validated set of structured actions. It
cannot run code, issue server commands, or control movement each game tick.
Plans are limited to eight actions, direct collection/crafting quantities are
capped at 64, deterministic acquisition totals at 2,304, movement is capped at
128 blocks per move action, fixed strip mines are capped by
`MAX_AUTONOMOUS_TUNNEL_LENGTH` (1,024 by default), and waits are capped at 30 seconds. A whispered `stop`
aborts navigation, collection, and an
in-flight model request.

Block collection automatically selects the best suitable axe, pickaxe, shovel,
or other harvesting tool already in the inventory. The `equip_tool` action also
lets the assistant explicitly equip its best available tool of a requested type.

Items listed in `AUTO_DISPOSE_ITEMS` are automatically dropped shortly after
entering inventory. Use singular Minecraft registry names separated by commas:

```dotenv
AUTO_DISPOSE_ITEMS=rotten_flesh
```

Remove an item from this list if the assistant should retain it for crafting or
giving to another player. Sticks are intentionally retained because autonomous
tool replacement depends on them.

Adjust these limits in `.env`:

```dotenv
MAX_ACTIONS_PER_PLAN=8
MAX_PLANS_PER_GOAL=6
MAX_CONSECUTIVE_AI_FAILURES=6
MAX_MOVE_DISTANCE=128
MAX_EXPEDITION_DISTANCE=2048
OBSERVATION_DISTANCE=16
PATHFINDER_THINK_TIMEOUT_MS=15000
PATHFINDER_SEARCH_RADIUS=32
LOCAL_PATHFINDER_SEARCH_RADIUS=10
BUILD_SITE_SEARCH_RADIUS=24
TASK_STALL_MS=12000
COLLECT_SEARCH_DISTANCE=64
COLLECT_MAX_PATH_FAILURES=4
EQUIPMENT_REQUEST_WAIT_MS=60000
MAX_AUTONOMOUS_TUNNEL_LENGTH=1024
MEMORY_RESTART_MB=1536
```

Named places and discovered containers persist in `.state/landmarks.json`.
Long trips are divided into bounded local paths and refuse destinations beyond
`MAX_EXPEDITION_DISTANCE`. Mine entrances and descent routes are remembered, so
storage restocks and overflow unloading can visit a previously inspected chest
and return to the work position instead of abandoning the job. Known container
contents prevent pointless restock trips.

`return_to_surface` prefers the saved reverse route from the latest staircase.
For older mines without route metadata, it searches for an already-walkable
ascent in bounded 10-block Y segments; it does not dig straight upward. When a
recursive recipe needs surface logs while the bot is underground, it attempts
this return automatically before declaring wood unavailable.

Collection repeatedly searches the current chunk, then the surrounding 3x3
chunks, then the nearest loaded match within 64 blocks. After harvesting one
block it repeats the search from its new position. `any_log` lets generic wood
requests match every natural log type, while `any_ore` supports generic cave-ore
requests. Specific overworld ores such as `iron_ore` automatically include their
deepslate variant. It stops cleanly with partial progress after four consecutive
unreachable targets. A process lock prevents duplicate-login reconnects.
Offline connection retries use exponential backoff from five seconds to a
60-second ceiling, then reset after the next successful spawn. This prevents an
unattended offline server from flooding the terminal with repeated failures.
Block scans are cached while the bot remains in the same area. Failed targets
enter a two-minute unreachable cooldown so pathfinding does not repeatedly
expand the same impossible route and exhaust the Node heap.

Movement is watched for genuine stalls while preparing actions as well as while
pathfinding, digging, or placing. This includes storage trips, eating, sleeping,
tool crafting, and workstation placement that happen before the main skill.
After 12 seconds without position progress, safe idempotent actions are aborted,
the collision/path cache is cleared, and the bot makes one bounded attempt to
move to a nearby standable block or tower out of a fall. Only after that retry
fails does Gemma receive a typed `navigation`, `missing_resource`,
`unsafe_or_blocked`, `transient_world`, or `skill_error` event.
Strip mining is included in that deterministic one-retry recovery path. Idle
tool maintenance is cancelled and allowed to finish cleaning up its temporary
workstation before a player goal or emergency response starts, preventing two
controller operations from moving or placing blocks concurrently.

Dirt, grass, sand, gravel, clay, and similar terrain are harvested one horizontal
Y level at a time. The selector only chooses exposed surface blocks and never
targets the block directly beneath the bot. Logs are harvested from the bottom
of the nearest tree upward, and ores stay nearest-first so a discovered vein is
finished before the bot searches farther away. A started tree is completed even
if that slightly exceeds the requested quantity. Temporary dirt/stone climbing
blocks are tracked, dismantled from the tree base afterward, and recovered. The
bot then sweeps the tree base for fallen logs, saplings, apples, and scaffold
drops before leaving.

`strip_mine` creates a level two-block-high cardinal tunnel, equips the required
tool for each block, and collects ores exposed within four blocks as it advances.
Before starting each tunnel segment, it scans up to sixteen blocks in all four
cardinal directions. A sustained open corridor directly ahead indicates a
retrace, while a sustained open corridor one block to either side indicates a
parallel mine that would widen into a 2×2 passage; in either case it chooses the
cleanest direction. A single open cell is treated as a normal crossing and does
not force a turn.
It stops instead of entering lava, water, a floor opening, an unbreakable block,
or unstable sand/gravel. When torches are available, it places one every eight
blocks. Targeted strip mines must start within 12 Y levels of the recommended
depth (diamond/redstone −59, gold −16, iron 16, copper 48, coal 96), and strip
mining must be explicitly requested by the player.
Long strip mines checkpoint completed main-tunnel distance every eight blocks.
After a disconnect, the saved action is shortened to only its unfinished length
and resumes from the bot's current position instead of starting the full length
again.

`staircase_to` and `staircase_to_y` create a two-block-wide, four-block-high
walkable staircase to a resource level or explicit Y coordinate. They do not
continue into resource collection unless that was part of the player's goal.
Before digging, the bot previews up to twelve descending steps in each cardinal
direction for liquids, missing floors, unloaded blocks, and unbreakable blocks,
then selects one heading. That heading is locked for the entire staircase: a
later obstruction stops the task with its direction and completed step count
instead of producing a zigzag or loop. Dry, supported floor gaps are not treated
as obstructions when dirt, cobblestone, stone, or another scaffold block is
carried; the bot fills both staircase lanes and continues forward. Floor repair
also confirms the resulting world block after a delayed placement response.
If the bot falls through a broken stair floor, it uses carried dirt or stone to
tower back to the expected step and repairs the floor across both stair lanes.

Every three main-tunnel blocks by default, the miner opens conventional
two-high, sixteen-block branches on both sides, leaving two solid blocks between
adjacent branches so their exposed faces cover the intervening rock efficiently.
A blocked or flooded side branch is abandoned safely after the bot returns to
the main gallery; it no longer ends the whole strip mine. Retreat follows
four-block waypoints through the exact cells the branch excavated, with
pathfinder digging disabled, instead of asking for one fragile long route back.
The miner clears a
bounded fall of sand or gravel and bridges small floor gaps with carried dirt or
stone. It harvests the ore veins the branches expose, including ceiling, floor,
and diagonally connected blocks. Before mining an ore directly underfoot it
moves to a nearby two-block-high stance with a solid dry floor; unsafe blocks
are deferred instead of opening a fall beneath the bot. If no open stance
exists, it can carve a bounded two-block-high side pocket through ordinary
diggable rock, verify its floor and headroom, step into it, and continue the
vein. It will not use an ore, liquid, unsupported block, or unbreakable block as
that pocket's floor. A targeted mine collects only
its requested ore family, so a diamond run no longer diverts into copper or
lapis; a general strip mine still gathers every exposed ore. Falling water or
lava is given a sump beneath its flow so it does not spread across the tunnel;
lava still stops forward progress. The miner reads block and sky light after every advance. When
effective light reaches 0, it crafts torches from coal or charcoal and sticks if
needed, then places a torch on the tunnel floor. Scheduled lighting also scans
the nearby tunnel for previously placed floor or wall torches, so returning from
a branch does not over-light the gallery. If Mineflayer times out waiting for a
placement acknowledgement, the controller verifies the target block before
trying a fallback position. `mine_resource` first cuts a walkable staircase—never a vertical
shaft—to the resource level, then continues turning and branch-mining until the
requested inventory quantity is reached or the configured 1,024-block safety
limit is exhausted.

When fewer than two inventory slots remain, long-running work pauses and the bot
uses the nearest reachable chest, trapped chest, or barrel before returning to
the exact work area. Mining unloads stone, cobblestone, deepslate, tuff, gravel,
and similar bulk blocks while retaining one stack of dirt/stone scaffolding.
Woodcutting and foraging unload logs, wood, planks, saplings, and gathered
flowers. Required goal items are retained while an `acquire_item` recipe is in
progress, and tools, food, torches, the crafting table, ores, and other supplies
are never selected as contextual overflow. If no reachable container has room,
the task stops safely instead of throwing away unconfigured materials.
During mining, if no container is reachable but spare planks are available, the
bot can craft and place expedition chests, unload bulk stone, and remember their
positions and contents. It confirms the actual world block after a late
placement acknowledgement and can roll over through three new chests in one
unload cycle if an earlier chest fills before enough inventory slots are free.
Woodcutting never consumes its wood goal to create one.
Missing remembered containers are removed from the persistent landmark store.
When a remembered chest no longer contains the expected item or has no room,
the controller closes it and tries the next suitable chest instead of repeatedly
returning to the stale location.

During work, the bot maintains one pickaxe, axe, shovel, and hoe as materials
allow. A tool is replaced after it breaks, iron is preferred over stone as soon
as iron is available, and raw iron can be smelted with a nearby or temporarily
placed furnace. One crafting table is reserved in inventory. The bot uses the
nearest reachable table when possible; otherwise it places its own, crafts, then
breaks and walks onto the drop to recover it. Temporary crafting tables and
furnaces are not logged as recovered until their item is back in inventory.
Long collection and tunnel operations verify that each block actually broke;
if a working tool disappeared during the dig, the bot prepares its replacement
and retries that same block once instead of blacklisting the target.

Tool-set maintenance runs only while the bot is idle, so a workstation problem
cannot prevent a new player goal from reaching the planner. Explicit crafting
actions verify inventory recipes, use or temporarily place a crafting table when
required, and recover it afterward. Temporary placement clears replaceable
terrain, verifies timeouts against the actual world block, and tries another safe
adjacent position when necessary.

Ordinary navigation, following, storage trips, and workstation travel run with
pathfinder digging disabled. Only deterministic mining and collection skills may
alter blocks, which prevents walking goals from cutting convoluted shortcuts
through an existing base or mine.

`acquire_item` is the deterministic resource catalogue. It reads Minecraft's
recipe ingredient graph, recursively obtains prerequisites, selects the local
wood family, crafts intermediate items, applies harvest-tier prerequisites, and
smelts iron/copper/gold, charcoal, glass, stone, cooked food, and dried kelp.
Fuel selection reserves the furnace input, so a log cannot be counted as both
charcoal input and fuel. This replaces long, fragile LLM-authored crafting
chains with one resumable controller task.

The bot can deposit into and withdraw from the nearest reachable loaded chest,
trapped chest, or barrel. Automatic unloading sorts gathered materials before
using general overflow storage. It recognizes exact items already stored in a
container, nearby item frames, and nearby sign labels such as `stone chest`,
`wood chest`, `ores`, `valuables`, `food`, `plants`, or an exact item name.
Item-frame and sign matches take priority over learned contents; if no matching
container has room, remaining eligible stacks are dumped into the next chest
with capacity. The maintained tool set, crafting table, torches, sticks, shield,
one mining scaffold stack, and active recipe prerequisites remain protected.
Container windows are always closed, inspected
contents are cached for later planning/status context, and clear storage
whispers use the local intent fast path. Automatic inventory-pressure cleanup
drops only `AUTO_DISPOSE_ITEMS`; it will not silently throw away other stacks.
One crafting table and the best carried pickaxe, axe, shovel, and hoe are
reserved from automatic disposal even if accidentally listed as trash.
Explicit storage quantities can span several nearby containers. If a chest
accepts or supplies only part of a request, the controller measures the actual
inventory change and carries the exact remainder to the next eligible chest.
Automatic mining and foraging unloads use the same measured partial-transfer
accounting and continue across sorted chests until the unload trip is complete.

Before collecting a block or fallen item, the controller checks whether its
actual registry drop can fit in a free or partially filled stack. Resource
mining stops with an `inventory_full` event instead of continuing to mine items
that cannot be carried.

Single-block harvesting now uses one bounded path to a player-reachable stance,
equips the correct tool, and digs directly. It does not invoke the collector
plugin's broad path search for every log, dirt block, scaffold, or ore. This
removes the runaway search pattern that previously grew the heap to several
gigabytes during strip mining.

Every action also has a progress watchdog. Position changes, block updates,
inventory updates, collection events, and task-counter changes reset it. A
pathfinder that stops moving while leaving a plugin operation unresolved is
cancelled and sent through bounded recovery instead of hanging the goal forever;
explicit `wait` actions are exempt.

Minecraft 1.21 component-based item enchantments are normalized before the
tool-selection plugins and Mineflayer's final `digTime` call calculate mining
speed. This avoids the legacy
`enchantments is not iterable` crash seen with some carried tools. Because
`mineflayer-collectblock` requires a genuinely empty inventory slot even when a
drop could stack, collection now reserves one first or reports `inventory_full`
cleanly instead of repeatedly asking for undefined chest locations.

Before long work, the controller performs a deterministic player-style
preflight: it equips the strongest carried armor, eats when hungry, tries a
nearby bed before outdoor work at night, and restocks known supplies. Mining
prepares a usable pickaxe, sticks, crafting table, and torches; combat prepares
a sword and shield when resources permit. Combat uses timed attacks, shields
against ranged mobs, backs away from creepers, and abandons the fight at low
health. Without a shield it detects arrows, tridents, fireballs, and wind
charges moving toward it and makes a short lateral dodge. Shield and movement
controls are released after every fight or interruption. Validated actions can
use nearby doors, gates, trapdoors, buttons, levers, and bells.
Automatic defense attacks only a nearby lower-risk hostile when the bot has at
least 12 health, adequate hunger, and a usable weapon. Otherwise it retreats.
Persistent `guard me` follows the named player and uses those same safety rules.

Mining preflight inspects a nearby chest even when it has not appeared in the
persistent cache yet, and retrieves the best available pickaxe, up to 32
torches, and one crafting table in a single visit. This lets an inherited or
older checkpoint recover from a broken tool without first teaching the new
process where its storage is.

Farming harvests mature wheat, carrots, potatoes, beetroot, and nether wart,
deliberately collects the server-spawned crop and seed drops, then replants from
inventory. Seed needed for continued replanting is protected when a full
inventory is unloaded. Hunting likewise collects nearby drops before trying to eat, and ore
vein mining follows the connected deposit (up to a 128-block safety cap) and
sweeps the opened cavity before returning to the main gallery. Drops spawned
above the bot by ceiling ores are allowed to fall into pickup range before any
pathfinding attempt, avoiding impossible paths to mid-air item entities. A
drop is counted only after its entity disappears, rather than merely because
the bot reached its coordinates; moving drops are approached again, and partial
pickup requests are reported as partial. It can create a compact irrigated overworld crop
plot from carried seed, a hoe, and a water bucket. Re-running farm creation
keeps an existing water source, farmland, and planted crops intact.

At moderate hunger, eating may cook up to four carried raw food items when a
furnace and fuel are practical, then chooses food by both hunger restoration and
saturation. At critical hunger it skips cooking and eats immediately. Broken
weapons and armor are ignored during equipment selection, equipped armor is not
downgraded, and configured trash disposal always reserves eight sticks, sixteen
torches, one shield, and the best usable copy of each tool and sword.

## Development checks

```bash
npm run check
npm test
npm run probe:ai
```

## Local blueprints

Local building blueprints live in `schematics/`. `starter_home.json` is a
7×5×7 wooden shell represented as Y layers, with rows ordered from front to
back and characters ordered left to right. Its `any_planks` palette token can
be resolved to one available plank type when schematic building is enabled.
The loader rejects path traversal, malformed dimensions, duplicate layers,
unknown palette symbols, and structures over 32,768 blocks. Version 2 palettes
may attach block-state properties such as facing or axis; horizontal facings are
rotated with the structure. The bot can collect
all required materials with `collect_build_materials`, then place the validated
blocks bottom-up with `build_schematic`. Existing matching blocks are treated as
completed checkpoints. Replaceable grass and flowers are cleared and small
foundation gaps are filled, while unrelated solid obstructions still stop the
build instead of being silently destroyed.
WorldEdit Sponge v3 `.schem` files can be converted with
`npm run convert:schem -- input.schem schematics/output_name.json`. Optional
`--min-y N` removes export layers below the useful structure and
`--trim-terrain` omits dirt, grass, farmland, crops, and water. The importer
preserves block states and supports cases where an inventory item places a
different block state, such as torches on walls. Entity NBT, container contents,
sign text, paintings, and other entities are intentionally not imported.
Each started build saves its anchor, facing, and dimension. A later
`repair_schematic` audits that saved structure, gathers only its missing or
incorrect blocks, and reuses the idempotent builder to repair those positions.
The saved entry refers to the most recently started copy of each schematic.
During construction, pathfinder may use carried dirt or stone as temporary
access scaffolding. Those placements are tracked separately from schematic
blocks and recovered afterward. Build progress is checkpointed every eight
placements, and a resumed build counts existing matching blocks and requires
only the materials still missing.
Large schematics do not require every material to fit in the bot inventory.
Construction consumes carried items first, withdraws the next stack-sized batch
from nearby or remembered chests and barrels, returns to the build site, and
continues. If every reachable supply container is exhausted, the task stops on
the exact missing item and remains resumable after that item is supplied.
Placement is phased: structural blocks are completed bottom-up first, attached
functional blocks follow, and optional decoration/furniture is last. Missing
optional items are skipped and whispered as a materials list when the shell is
finished; supplying them later and requesting schematic repair fills them in.
Before withdrawing supplies, construction checks every required schematic
position and rejects solid site collisions. Stateful placement chooses wall
supports and upper/lower click halves where needed, then verifies the resulting
block identity plus stable facing, axis, half, and slab-type properties.
If the requested base layer intersects the surface, the builder tries the
complete schematic exactly one block higher and accepts that adjustment only
when the raised shell passes preflight. It does not keep floating upward to
bypass hills, trees, buildings, or other obstructions.
If that requested footprint is invalid and no schematic blocks have yet been
placed, the builder surveys candidates nearest-first within
`BUILD_SITE_SEARCH_RADIUS` (24 blocks by default). A candidate must have a
uniformly supported footprint, four clear working blocks above every footprint
column, and a fully valid structural preflight. Partially built structures are
never relocated.
The requesting player's yaw supplies the preferred build orientation. The
survey tests that orientation first, then both quarter-turns and the opposite
orientation at each candidate distance, so the bot's incidental facing cannot
project a large structure into nearby trees.
Tree trunks, leaf canopies, containers, and workstations are never accepted as
flat terrain. Once a site is selected, the bot tries multiple safe approach
points around its edge (and the empty interior as a fallback) and walks there
before construction begins.
