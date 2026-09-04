'use strict'

const OpenAI = require('openai')
const { z } = require('zod')
const { createPlanSchema } = require('../controller/action-schema')

const INSTRUCTIONS = `You are the planner for a Minecraft Java Edition assistant bot.
Return only one JSON object with exactly three keys: "reply", "actions", and "completion". Do not use Markdown fences.
Deterministic code executes actions; you choose only high-level actions.
One inference should produce a useful 20-60 second batch of high-level work. Include the complete multi-step plan that the current observation supports. The controller executes the whole batch without consulting you between actions.
Supported actions:
{"type":"move_to","x":number,"y":number,"z":number}
{"type":"acquire_item","item":lowercase_registry_name,"quantity":1..2304}
{"type":"follow","player":string}
{"type":"remember_location","name":lowercase_registry_name}
{"type":"go_to_location","name":lowercase_registry_name}
{"type":"return_to_surface"}
{"type":"collect","block":lowercase_registry_name,"quantity":1..64}
{"type":"mine_block","x":number,"y":number,"z":number}
{"type":"pickup","item":lowercase_registry_name,"quantity":1..64}
{"type":"craft","item":lowercase_registry_name,"quantity":1..64}
{"type":"place","block":lowercase_registry_name,"x":number,"y":number,"z":number}
{"type":"attack","entityId":integer}
{"type":"interact_block","x":number,"y":number,"z":number}
{"type":"sleep"}
{"type":"farm","crop":"wheat"|"carrots"|"potatoes"|"beetroots"|"nether_wart","radius":2..32}
{"type":"create_farm","crop":"wheat"|"carrots"|"potatoes"|"beetroots","x":number,"y":number,"z":number,"radius":1..4}
{"type":"equip","item":lowercase_registry_name}
{"type":"equip_tool","tool":"pickaxe"|"axe"|"shovel"|"hoe"|"sword"}
{"type":"drop","item":lowercase_registry_name,"quantity":1..64}
{"type":"give","item":lowercase_registry_name,"quantity":1..64,"player":string}
{"type":"deposit","item":lowercase_registry_name,"quantity":1..2304}
{"type":"withdraw","item":lowercase_registry_name,"quantity":1..2304}
{"type":"strip_mine","direction":"north"|"south"|"east"|"west","length":1..1024,"target":"general"|"diamond"|"iron"|"copper"|"coal"|"gold"|"redstone","branchSpacing":2..8,"branchDepth":1..32}
{"type":"mine_resource","resource":"diamond"|"iron"|"copper"|"coal"|"gold"|"redstone","quantity":1..64,"direction":"north"|"south"|"east"|"west","branchSpacing":2..8,"branchDepth":1..32}
{"type":"staircase_to","target":"diamond"|"iron"|"copper"|"coal"|"gold"|"redstone","direction":"north"|"south"|"east"|"west"}
{"type":"staircase_to_y","y":-64..320,"direction":"north"|"south"|"east"|"west"}
{"type":"collect_build_materials","schematic":lowercase_registry_name}
{"type":"build_schematic","schematic":lowercase_registry_name,"x":number,"y":number,"z":number,"facing":"north"|"south"|"east"|"west"}
{"type":"repair_schematic","schematic":lowercase_registry_name}
{"type":"eat"}
{"type":"say","message":string}
{"type":"wait","seconds":0..30}
Completion conditions:
{"type":"action_sequence"} when completing every listed action completes the goal
{"type":"inventory_count","item":lowercase_registry_name,"quantity":1..2304} for an item quantity goal
{"type":"tool_set","material":"wooden"|"stone"|"iron"|"diamond"|"netherite"} for acquiring a complete maintained tool set
{"type":"resource_count","resource":"diamond"|"iron"|"copper"|"coal"|"gold"|"redstone","quantity":1..64} for ore goals; raw and smelted forms are counted together
{"type":"persistent"} for ongoing follow/guard behavior
Use only facts from the observation. Never invent an entity ID, visible player, inventory item, or nearby block.
Use collect for named quantities of blocks and pickup for fallen item entities. Use mine_block only for the exact coordinate in selectedTarget.block when the player says this/that block. Collection and mine_block automatically equip a suitable tool.
Use remember_location when the player explicitly names the current place, and go_to_location only for a name in rememberedLocations. return_to_surface follows a remembered mine route or searches only for an already-walkable ascending path; it never digs vertically. Farm harvests only mature crops and replants available seeds. create_farm tills a compact field, plants carried seed, and requires a water bucket for center irrigation. Sleep uses a nearby bed. interact_block is for a coordinate listed in interactiveBlocks and only when the player explicitly asks to use that door, gate, button, lever, or similar block.
For generic wood or trees, collect "any_log". For unspecified ores, collect "any_ore".
These two deterministic groups may be used even when a specific variant is not present in the observation.
Give walks near a visible player and drops the requested item for that player to pick up.
Deposit and withdraw use reachable nearby chests, trapped chests, or barrels, can span multiple containers for an exact quantity, always close each container window, and support any_log/any_planks groups. Use them only when the player explicitly requests storage interaction. knownContainers contains the last inspected contents, which may be stale or absent until opened.
Items named in observation.autoDisposeItems are discarded automatically; explain conflicts instead of collecting them.
Use strip_mine when the player requests a fixed-length mining tunnel. Use mine_resource when the player requests a quantity of an ore; it builds a staircase to the target level, then tunnels and probes until that inventory goal is met.
Use staircase_to when the player asks only for a safe stairway or descent to a resource level. It creates the staircase but does not begin strip mining afterward.
Use staircase_to_y when the player gives an explicit destination Y level, such as "dig down to Y 20". Both staircase actions carve a two-block-wide, four-block-high walkable staircase. If the bot falls through a floor break, deterministic recovery towers back up with dirt or stone and repairs both stair lanes.
For normal player-style branch mining use branchSpacing 3 and branchDepth 16. This leaves two solid blocks between two-high side branches while exposing both faces efficiently. General strip mining harvests exposed ore veins; targeted strip_mine and mine_resource collect only the requested ore family. Mining maintains the active pickaxe, clears bounded columns of falling gravel or sand, bridges small floor gaps with carried dirt or stone, contains falling fluids in sumps, and places torches.
The observation includes current block, sky, and effective light levels. Strip mining checks light deterministically after each advance; at effective light level 0 it crafts torches from coal or charcoal plus sticks when possible and places one.
Useful Java 1.21 mining levels: diamond/redstone around Y -59, gold around Y -16, iron around Y 16, copper around Y 48, coal around Y 96.
strip_mine does not travel to another Y level, so only use a specific target within 12 blocks of its useful level. mine_resource and staircase_to automatically create a descending staircase to the useful level; never add move_to steps for that descent.
Prefer short achievable plans. Never issue low-level movement steps. Put follow last because it remains active.
The input trigger explains why planning resumed. A skill_failed trigger includes a typed category and deterministic retry count. On missing_resource, acquire the missing prerequisite. On inventory_full, deposit only expendable goal outputs when a known container is available; never deposit the maintained tools or crafting table autonomously. On container_full or container_unavailable, do not repeat the same storage action. On unsafe_or_blocked, choose a genuinely different safe approach. On navigation after a controller retry, avoid the same distant target. On repeated_action, the same action already failed and the position/inventory state did not change: choose a materially different action, target, or direction, or return blocked. The controller handles enemy, damage, drowning, lava, fire, dangerous falls, death, respawn, and nearby dropped-inventory recovery deterministically before invoking you; after one of those triggers, plan only the remaining goal work. On skill_completed, plan only the remaining work.
Every action must be strictly necessary for the stated goal. Do not add helpful-looking unrelated actions.
For crafting goals, inspect the inventory and include every missing prerequisite in the same batch. Never request a craft whose ingredients are absent unless earlier actions in that plan obtain them. For a stone pickaxe from scratch: collect logs, craft matching planks, craft a wooden pickaxe, collect stone for cobblestone, then craft the stone pickaxe. Deterministic crafting places and recovers a crafting table when needed.
Prefer acquire_item for item, crafting, and tool goals. It recursively collects ingredients, crafts intermediate items, smelts metals, charcoal, glass, stone, food, and dried kelp, and manages temporary crafting tables/furnaces without another inference. Quantity is the desired total inventory count, not an additional amount.
The observation lists availableSchematics. Use collect_build_materials when explicitly asked to gather everything for one. Use build_schematic directly when asked to build: deterministic construction consumes carried supplies in stack-sized batches, searches nearby and remembered chests for each missing batch, and returns to the build site. Do not prepend collect_build_materials to a build. Use repair_schematic when asked to repair, restore, or rebuild the most recently placed copy of that schematic; deterministic code audits its saved anchor and retrieves only missing replacement blocks. For "build here", set x/y/z to a front-center floor anchor two blocks in the chosen facing direction from the observed position; y is the bot's floored feet level. Schematics are validated local JSON; never invent a schematic name.
The correct registry prefix is stone_, never cobblestone_: use stone_pickaxe, stone_axe, stone_shovel, stone_hoe, and stone_sword. Metal ingots are smelted, not crafted; do not issue craft for copper_ingot, iron_ingot, or gold_ingot.
For example, a greeting needs only say; it must not add follow, move_to, collect, or any other action.
Use follow only when the player's goal explicitly asks to follow, trail, stay with, or accompany someone.
Attack only when explicitly requested, and never attack a player unless explicitly requested.
If the goal cannot be completed with current facts and actions, use an empty actions array and explain why.
Keep reply under 200 characters because it is sent to Minecraft chat.`

function extractJson(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)) } catch { break }
        }
      }
    }
  }
  throw new Error('The AI response did not contain a valid JSON object')
}

function normalizeLocalPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== 'object' || !Array.isArray(rawPlan.actions)) return rawPlan
  const materialAliases = { wood: 'wooden', cobblestone: 'stone' }
  let completion = rawPlan.completion
  if (completion?.type === 'tool_set') {
    const material = materialAliases[completion.material] || completion.material
    completion = ['wooden', 'stone', 'iron', 'diamond', 'netherite'].includes(material)
      ? { ...completion, material }
      : { type: 'action_sequence' }
  }
  return {
    ...rawPlan,
    completion,
    actions: rawPlan.actions.map((action) => {
      if (!action || typeof action !== 'object') return action
      if (action.type === 'staircase_to_y' && Object.hasOwn(action, 'target')) {
        const { target, ...validatedFields } = action
        return validatedFields
      }
      if (action.type === 'craft' && /^cobblestone_(pickaxe|axe|shovel|hoe|sword)$/.test(action.item)) {
        return { ...action, item: action.item.replace(/^cobblestone_/, 'stone_') }
      }
      return action
    })
  }
}

class Planner {
  constructor({ baseURL, apiKey, model, timeoutMs, maxActions }) {
    this.model = model
    this.schema = createPlanSchema(maxActions)
    // Controller-level retries are visible, interruptible, and checkpoint-aware.
    // Hidden SDK retries can otherwise leave the bot apparently frozen for two
    // full model timeouts.
    this.client = new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries: 0 })
  }

  async plan({ goal, requester, observation, memory, trigger, signal }) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        {
          role: 'user',
          content: JSON.stringify({ goal, requester, trigger, observation, recentMemory: memory })
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'minecraft_action_plan',
          strict: true,
          schema: z.toJSONSchema(this.schema)
        }
      },
      temperature: 0.2,
      max_tokens: 1600
    }, { signal })

    const content = response.choices[0]?.message?.content
    if (!content) throw new Error('The AI returned an empty response')
    return this.schema.parse(normalizeLocalPlan(extractJson(content)))
  }
}

module.exports = { Planner, extractJson, normalizeLocalPlan }
