# Lore Theater (SillyTavern extension)

Lets the model build its own lore context before it replies. Using function tools, it can browse World Info, read entries, pin the ones it wants to keep, and purge tool results it no longer needs. A purged result is replaced in the prompt with a short note like `[Lore call #3 — content purged via call #7]`.

## Requirements
- Chat Completion API with **Enable function calling** turned on (AI Response Configuration).
- A model that supports tool calls.

## Install
Copy this folder to `SillyTavern/public/scripts/extensions/third-party/SillyTavern-LoreTheater`, or install it in the Extensions panel from `https://github.com/Lodactio/LoreTheater`. Then reload SillyTavern.

## Tools
| Tool | What it does |
|---|---|
| `lore_index` | Lists or searches entries. Shows ref (`Book#uid`), title, keys and a token estimate, without the content. |
| `lore_fetch` | Returns the full content of the given refs. |
| `lore_pin` / `lore_unpin` | Adds or removes entries in a persistent "Pinned lore" block (saved per chat). |
| `lore_purge` | Replaces earlier results with a purge note, by call number or `all: true`. |
| `lore_theater` | Shows the pins and any unpurged results with token estimates. |

Every result starts with `[Lore call #N]`, and that number is what the model passes to `lore_purge`. If a purge targets a call from the same tool batch, it is queued and applied once SillyTavern saves that batch.

## How it works
SillyTavern keeps tool results in the chat (`message.extra.tool_invocations[].result`) and rebuilds the prompt from them on every generation. Purging rewrites the stored result, so the next round of the tool loop already sees the shorter context. Pinned entries are added with `setExtensionPrompt`.

## Settings
- **Expose lorebooks active in this chat**: makes enabled entries from global, character, chat and persona books available to the tools.
- **Tool-only lorebooks**: every entry in these books is available to the tools. Keep these books *inactive* in SillyTavern so they never trigger by keyword. Only the model can bring them in.
- **Auto-purge**: when you send a new message, results from the previous turn are purged and pins stay. Swiping or regenerating the last reply keeps them.
- **Inject usage instructions**: adds a short system note that explains the workflow to the model.
- Position, depth and role for the pinned block, plus buttons to clear pins and purge all results.

## License
AGPL-3.0. See [LICENSE](LICENSE).
