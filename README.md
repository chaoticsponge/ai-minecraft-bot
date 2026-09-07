# Mineflayer AI Assistant

A Minecraft Java Edition assistant built with [Mineflayer](https://github.com/PrismarineJS/mineflayer). An LLM chooses high-level goals while deterministic code handles movement, mining, crafting, tool use, survival, storage, farming, and schematic building.

The model does not control movement every tick, so even a relatively slow local model can be useful:

```text
Minecraft -> deterministic controller -> AI planner
```

## Requirements

- [Node.js 18 or newer](https://nodejs.org/)
- A Minecraft Java server the bot can join
- An OpenAI-compatible Chat Completions server

The included defaults target Minecraft `1.21.11` at `localhost:49615` and an AI server at `http://127.0.0.1:8080/v1`.

## 1. Install the bot

Clone this repository, open a terminal in it, and run:

```bash
npm install
cp .env.example .env
```

Open `.env` in a text editor. At minimum, set the Minecraft port, bot username, authorized player name, and model name:

```dotenv
MC_HOST=localhost
MC_PORT=49615
MC_USERNAME=MineflayerBot
MC_VERSION=1.21.11
MC_AUTH=offline

ALLOWED_USERS=YourMinecraftName

AI_BASE_URL=http://127.0.0.1:8080/v1
AI_MODEL=your-model-name
AI_API_KEY=
```

Use `MC_AUTH=offline` only for an offline-mode/local server. For a normal online-mode server, use:

```dotenv
MC_AUTH=microsoft
MC_USERNAME=your-microsoft-account@example.com
```

The first startup will print Microsoft device-login instructions.

## 2. Start a local AI server

Use either option below, or any service that exposes an OpenAI-compatible `/v1/chat/completions` endpoint.

### Option A: TurboFieldfare on Apple Silicon

[TurboFieldfare](https://github.com/drumih/turbo-fieldfare) runs Gemma 4 26B-A4B locally on Apple Silicon. It currently requires macOS 26, Xcode 26, Swift 6.2, and about 15 GB of storage.

```bash
git clone https://github.com/drumih/turbo-fieldfare.git
cd turbo-fieldfare
swift build -c release
.build/release/TurboFieldfareMac
```

Use the app to download the model. Close the app after installation, then start its API server:

```bash
swift build -c release --product TurboFieldfareServer
.build/release/TurboFieldfareServer --model scratch/gemma4.gturbo
```

Use these bot settings:

```dotenv
AI_BASE_URL=http://127.0.0.1:8080/v1
AI_MODEL=gemma-4-26b-a4b-it
```

### Option B: llama.cpp

Install [llama.cpp](https://github.com/ggml-org/llama.cpp), choose an instruction-tuned GGUF model that fits your computer, and start `llama-server`:

```bash
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 -c 8192
```

Recent llama.cpp builds can also download a compatible model from Hugging Face:

```bash
llama-server -hf ggml-org/gemma-3-4b-it-GGUF --host 127.0.0.1 --port 8080 -c 8192
```

Set `AI_MODEL` to the model name reported by your server. Do not expose either unauthenticated local server to the internet.

## 3. Check the AI connection

Keep the AI server running. From the bot directory, run:

```bash
npm run probe:ai
```

If it prints a JSON plan, the model connection works.

## 4. Start the bot

Start your Minecraft server first, then run:

```bash
npm start
```

By default, send commands privately with `/w`:

```text
/w MineflayerBot collect 32 oak logs
/w MineflayerBot create a strip mine here and get 12 diamonds
/w MineflayerBot make a stairway to diamond level
/w MineflayerBot craft an iron pickaxe
/w MineflayerBot follow me
/w MineflayerBot build the starter home here
/w MineflayerBot status
/w MineflayerBot stop
```

`stop` immediately interrupts the current task. `status` reports current progress. Long tasks are checkpointed and can resume after a reconnect.

## Public chat and command prefixes

Whispers are the default. To also accept commands in public chat, configure a required prefix:

```dotenv
PUBLIC_CHAT_COMMANDS=true
AI_COMMAND_PREFIX=!ai
```

Then use:

```text
!ai collect 32 oak logs
!ai create a strip mine here and get 12 diamonds
!ai status
!ai stop
```

The bot still replies privately. A prefix is mandatory in public-chat mode so normal conversation cannot trigger it. Set `PUBLIC_CHAT_COMMANDS=false` and leave `AI_COMMAND_PREFIX=` blank for prefix-free whispers.

## Common configuration

```dotenv
# Minecraft connection and bot identity
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=HelperBot
MC_VERSION=1.21.11

# Players allowed to command the bot (comma-separated)
ALLOWED_USERS=Steve,Alex

# Automatically discard these registry items
AUTO_DISPOSE_ITEMS=rotten_flesh
```

Sticks are retained by default because the bot needs them to replace tools. See `.env.example` for pathfinding, distance, timeout, reconnect, and memory limits.

## What it can do

- Gather blocks and dropped items with the appropriate tool
- Craft, smelt, eat, equip, give, drop, and sort items into labelled chests
- Maintain tools and ask the player when required equipment cannot be acquired
- Dig straight staircases and player-style branch/strip mines, collect safe ore veins, and place torches
- Follow or guard players and react to hunger, damage, lava, drowning, falls, and hostile mobs
- Farm crops and build validated local JSON schematics, including directional and multi-block doors/beds
- Save progress across disconnects and controlled restarts

The AI can only select validated high-level actions. It cannot execute code or issue arbitrary server commands.

## Schematics

JSON blueprints live in `schematics/`. Convert a WorldEdit Sponge v3 `.schem` file with:

```bash
npm run convert:schem -- input.schem schematics/my_build.json
```

Then ask the bot to collect the materials and build it:

```text
/w MineflayerBot collect the materials for my build
/w MineflayerBot build my build here
```

## Development

```bash
npm run check
npm test
```

Runtime state is stored in `.state/`, Microsoft authentication in `.auth/`, and private settings in `.env`. These paths should remain ignored by Git.
