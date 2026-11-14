# my-action

Says hello to someone. The model of a TypeScript action for Cronplane: copy this folder, rename the action, keep the checks.

## Inputs

| Input | Type | Use |
|---|---|---|
| `who` | string, untrusted | Who to greet. Untrusted: it is only printed and returned, never run nor used as a target. |
| `shout` | boolean | Greets in capitals. |

## Outputs

| Output | Type |
|---|---|
| `greeting` | string |

## Checking it

```sh
export CRONPLANE_BIN=/path/to/cronplane
bun <kit>/ts/src/cli.ts check .
```
