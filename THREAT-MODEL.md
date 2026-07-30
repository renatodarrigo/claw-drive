# Threat model

claw-drive gates a **cooperative** agent against **accidental** damage. It is **not** a sandbox against an **adversarial** one.

The policy layer reads each tool call a driven session makes and decides — from a list of regex rules — whether to auto-approve it, surface it to you, or reject it. That is the whole mechanism. It is good at what it is for: keeping a well-intentioned agent from running `rm -rf` on the wrong directory, pushing to the wrong remote, or rewriting its own policy by mistake. It is not a security boundary that contains code actively trying to get out.

## What it defends against

- A cooperative agent issuing a destructive command by mistake — `rm -rf`, `git push`, `git reset --hard`, `mkfs`, a write to a block device.
- An agent rewriting its own policy or claw-drive's runtime state: the shipped templates auto-reject `Edit`/`Write` and the common shell write vectors against the policy file and `~/.claw-drive/`.
- High-risk-but-recoverable actions you want to see before they run — `sudo`, recursive `chmod`/`chown`, service teardown — which surface to you per call.

## What it does NOT defend against

The policy matches the **command string**. It does not execute the command, parse a language, or follow data through a pipe. Three classes of action slip past a regex by construction:

1. **Interpreter one-liners.** `python -c "…"`, `node -e "…"`, `perl -e`, `ruby -e`, `php -r`, `eval`, and `sh`/`bash`/`zsh -c` all run code the regex never sees. The shipped templates **defer** these to you — a cooperative agent rarely needs them for routine work, so the friction is low and the dual-use vector is caught. But the deferral surfaces the *command*, not what the code inside it does. At that point you are the inspector.
2. **Indirect writes.** A write piped through an interpreter or a redirection — `python -c 'open(p,"w").write(…)'`, `printf … > file` — reaches the filesystem without going through the `Edit`/`Write` tool rules.
3. **Obfuscated or encoded commands.** `base64 -d | sh`, env-var indirection (`$CMD`), here-strings, and similar can hide a payload from a literal-string match.

These are not bugs to be patched one regex at a time. They are a property of gating at the command-string layer.

## Context rotation and the handover trust boundary

Rotation hands a session off to a fresh successor via a handover document that Session B writes itself. That handover is **B-authored content** — the same trust class as any other B output (assistant text, tool arguments, file edits). It is injected verbatim into the successor's first turn; rotation introduces no new privilege boundary and no new class of trusted input. A cooperative B produces a faithful progress report, and the successor treats it the way it would treat a plan carried over from an earlier turn of the same conversation.

The one piece of rotation machinery that isn't B-authored — the runner-prepended, verbatim ORIGINAL MISSION section stitched onto every successor's brief — exists to bound **drift**, not to defend against **injection**. Its job is keeping a multi-generation lineage anchored to the task you actually gave it, instead of telescoping through each generation's paraphrase of the one before. It is not a security control: under this threat model B is cooperative, so there is no adversary for it to repel.

Crash recovery's distiller runs a one-shot, minimal-mode `claude -p` call that loads no settings sources, has no tools at all, and runs from a neutral cwd, so it has neither hooks, project memory (`CLAUDE.md`), nor anything to call. It cannot re-enter claw-drive's own approver hook, recurse into the gated tool surface, or invoke a tool in the first place — structurally, not just by policy — so reconstructing a handover from a dead session's event log cannot become a path back into tool execution.

## If you need to contain an adversarial agent

Run the driven session inside an **OS-level sandbox** — a container, or a namespace/seccomp jail — that bounds what the process can touch regardless of what command it runs. claw-drive does not provide its own sandbox; it gates tool calls inside whatever boundary you put around it. Use both together: the sandbox is the wall, claw-drive is the reviewer at the desk inside it.
