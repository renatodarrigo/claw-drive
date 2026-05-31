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

## If you need to contain an adversarial agent

Run the driven session inside an **OS-level sandbox** — a container, or a namespace/seccomp jail — that bounds what the process can touch regardless of what command it runs. claw-drive does not provide its own sandbox; it gates tool calls inside whatever boundary you put around it. Use both together: the sandbox is the wall, claw-drive is the reviewer at the desk inside it.
