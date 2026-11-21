/**
 * Write Cronplane actions in TypeScript, for Bun.
 *
 * ```ts
 * import { Action } from "@cronplane/actions";
 *
 * const action = Action.fromEnvironment();
 * const answer = await action.http.postJson(action.inputs.string("url"), { name: "x" });
 * action.outputs.set("status", answer.status);
 * ```
 */

export { Action, type Environment, Inputs, MAX_OUTPUT_BYTES, Network, Outputs, type Scalar } from "./action.ts";
export { isLoopback, isPublic } from "./address.ts";
export {
  ActionError,
  EgressError,
  HttpError,
  InputError,
  OutputError,
  RejectedError,
  SchemaError,
  SecretError,
  SmtpError,
  StateError,
  StreamError,
  VersionError,
} from "./errors.ts";
export { type Address, Egress, HttpClient, type HttpOptions, type Resolve, Response } from "./http.ts";
export type { JsonValue } from "./json.ts";
export { AllowedHosts } from "./network.ts";
export { Problem, RecordSchema } from "./schema.ts";
export { type Message, SmtpClient, type SmtpOptions } from "./smtp.ts";
export { MAX_STATE_BYTES, State } from "./state.ts";
export {
  type Closing,
  type ReaderOptions,
  StreamReader,
  type StreamRecord,
  Streams,
  StreamWriter,
  type WriterOptions,
} from "./streams.ts";
export { REQUIRES_CRONPLANE } from "./version.ts";
