#!/usr/bin/env bash
# Package the sponsorship-portal skill for every tool that can consume it.
#
#   scripts/package-skill.sh            → dist/skill/
#
# Produces:
#   dist/skill/sponsorship-portal-skill.zip   Agent Skills bundle (SKILL.md + reference/). Upload to Claude.ai
#                                             (Settings → Capabilities → Skills), or unzip into
#                                             ~/.claude/skills/ (Claude Code), ~/.agents/skills/ (Codex CLI),
#                                             ~/.config/devin/skills/ (Devin).
#   dist/skill/chatgpt/instructions.md        Custom GPT "Instructions" (checked to be ≤ 8000 characters).
#   dist/skill/chatgpt/knowledge/*.md         Files to upload under the GPT's "Knowledge".
#   dist/skill/INSTALL.md                     Per-tool install notes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.devin/skills/sponsorship-portal"
OUT="$ROOT/dist/skill"
rm -rf "$OUT" && mkdir -p "$OUT/chatgpt/knowledge" "$OUT/bundle/sponsorship-portal"

# 1. Agent Skills bundle (portable SKILL.md format: name + description frontmatter, references alongside)
cp "$SRC/SKILL.md" "$OUT/bundle/sponsorship-portal/SKILL.md"
cp -R "$SRC/reference" "$OUT/bundle/sponsorship-portal/reference"
( cd "$OUT/bundle" && zip -q -r -X "../sponsorship-portal-skill.zip" sponsorship-portal )
rm -rf "$OUT/bundle"

# 2. ChatGPT Custom GPT: instructions + knowledge
cp "$SRC/gpt/instructions.md" "$OUT/chatgpt/instructions.md"
chars=$(wc -m < "$OUT/chatgpt/instructions.md" | tr -d ' ')
if [ "$chars" -gt 8000 ]; then echo "ERROR: GPT instructions are $chars characters (limit 8000)"; exit 1; fi
cp "$SRC/SKILL.md" "$OUT/chatgpt/knowledge/00-playbook-SKILL.md"
cp "$SRC"/reference/*.md "$OUT/chatgpt/knowledge/"
cp "$ROOT/scripts/smoke-test.sh" "$OUT/chatgpt/knowledge/smoke-test.sh.md"          # GPT knowledge accepts .md reliably
cp "$ROOT/netlify.toml" "$OUT/chatgpt/knowledge/netlify.toml.md"

# 3. Install notes
cat > "$OUT/INSTALL.md" <<'EOF'
# Installing the sponsorship-portal skill

## Claude.ai (web / desktop)
Settings → Capabilities → Skills → Upload skill → choose `sponsorship-portal-skill.zip`. Claude will use it
whenever a conversation is about building or running an athlete sponsorship portal. It cannot run commands, so
it guides you and you paste outputs back.

## Claude Code
```sh
unzip -o sponsorship-portal-skill.zip -d ~/.claude/skills/          # global
# or, inside a portal repo, the skill is already discovered via .claude/skills/sponsorship-portal
```
Invoke with `/sponsorship-portal` or just describe the task.

## Codex CLI (OpenAI)
```sh
unzip -o sponsorship-portal-skill.zip -d ~/.agents/skills/          # global
# inside a portal repo it is discovered via .agents/skills/sponsorship-portal and AGENTS.md
```

## Devin
```sh
unzip -o sponsorship-portal-skill.zip -d ~/.config/devin/skills/    # global
# inside a portal repo it is discovered via .devin/skills/sponsorship-portal
```

## ChatGPT Custom GPT
1. chatgpt.com → Explore GPTs → Create.
2. Name: "Sponsorship Portal Architect". Paste `chatgpt/instructions.md` into **Instructions**.
3. Upload every file in `chatgpt/knowledge/` under **Knowledge**. Enable Code Interpreter (for reading files);
   Web browsing optional.
4. Conversation starters: "Start intake for a new athlete", "Walk me through launch", "A lock isn't invoicing",
   "Reset a placement after a test lock".
The GPT cannot run commands; it produces exact commands and file edits for you and verifies from pasted output.
EOF

echo "Packaged to $OUT"
echo "  bundle:        $(du -h "$OUT/sponsorship-portal-skill.zip" | cut -f1)  sponsorship-portal-skill.zip"
echo "  gpt prompt:    $chars / 8000 characters"
echo "  gpt knowledge: $(ls "$OUT/chatgpt/knowledge" | wc -l | tr -d ' ') files"
