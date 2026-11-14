import { Action } from "@cronplane/actions";

import { greeting } from "./greeting.ts";

const action = Action.fromEnvironment();
const text = greeting(action.inputs.string("who"), action.inputs.boolean("shout"));
console.log(text);
action.outputs.set("greeting", text);
