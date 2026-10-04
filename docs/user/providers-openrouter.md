# OpenRouter

Use one OpenRouter API key to run Codex, Claude Code, and OpenCode threads on
OpenRouter's models.

## Set up

Open **Settings > Providers** for the environment and find **OpenRouter**.

1. Paste your key into **OpenRouter API key** and select **Save key**. The key is
   stored on that environment's machine and is not shown again.
2. Select **Test connection** to check the key. You can test a key before saving it.
3. Turn on **Use OpenRouter for** Codex, Claude Code, or OpenCode.

Each switch adds a provider named **OpenRouter (Codex)**, **OpenRouter (Claude
Code)**, or **OpenRouter (OpenCode)**. Pick one of its models in the thread's model
picker. The harness itself still has to be installed on that machine; see
[provider setup](./install.md#providers).

Turning a switch off disables that provider and keeps its threads. **Remove key**
turns all three off and deletes the stored key.

If you already have your own provider named `openrouter_codex`, `openrouter_claude`,
or `openrouter_opencode`, OpenRouter setup leaves it alone and that switch stays
unavailable. Rename your provider to use the switch.

## Models

The model list comes from OpenRouter and refreshes about once an hour. Use
**Refresh provider status** to fetch it now. Models that cannot call tools are left
out because a coding agent cannot use them.

OpenCode lists the OpenRouter models that OpenCode itself supports, so its list can
be shorter than the other two.

If a model you want is missing, open the OpenRouter provider in **Settings >
Providers** and add its full OpenRouter ID with **Add custom model**.

## Good to know

- The OpenRouter providers use your normal Codex and Claude Code configuration, so
  your skills, instructions, and MCP servers apply. Your `~/.codex/config.toml` is
  not changed.
- A thread stays on the side it started on. You cannot move a thread between an
  OpenRouter provider and a direct Codex or Claude provider; start a new thread
  instead.
- Claude Code shares your `~/.claude` configuration, so a cached claude.ai login can take
  priority over the OpenRouter key. If Claude Code does not use OpenRouter, run
  `/logout` in Claude Code once and try again. Bedrock, Vertex, Foundry and
  `CLAUDE_CODE_OAUTH_TOKEN` settings from your shell are switched off for the
  OpenRouter provider only.
- Usage is billed by OpenRouter. Check spend in OpenRouter's activity page.
- You can rename an OpenRouter provider or add environment variables to it like any
  other provider. Saving a new key updates all three.
