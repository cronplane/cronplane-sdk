"""Says hello to someone."""

from cronplane_actions import Action


def greeting(who: str, *, shout: bool) -> str:
    text = f"hello {who}"
    return text.upper() if shout else text


def main() -> None:
    action = Action.from_environment()
    text = greeting(action.inputs.string("who"), shout=action.inputs.boolean("shout"))
    print(text)
    action.outputs.set("greeting", text)


if __name__ == "__main__":
    main()
