/** The errors of the library: each says what the action cannot do and why. */

/** The action cannot go on: wrong environment, input, output, secret or request. */
export class ActionError extends Error {
  override name = "ActionError";
}

/** The Cronplane that runs the step is older than this library needs, or of another major version. */
export class VersionError extends ActionError {
  override name = "VersionError";
}

/** An input of the action is missing or not of the type asked for. */
export class InputError extends ActionError {
  override name = "InputError";
}

/** An output cannot be written: not JSON, or over the size Cronplane accepts. */
export class OutputError extends ActionError {
  override name = "OutputError";
}

/** A secret of the action is not given to the step. */
export class SecretError extends ActionError {
  override name = "SecretError";
}

/**
 * An address the worker forbids its steps to reach (`CRONPLANE_EGRESS=public`), a
 * host out of those the step may reach (`CRONPLANE_NETWORK_ALLOW`), or a host
 * reached in clear that is neither this machine nor one the step names
 * (`CRONPLANE_NETWORK_PLAIN`).
 */
export class EgressError extends ActionError {
  override name = "EgressError";
}

/**
 * A stream cannot be written or read: its name, its schema.json, its parts or
 * a line that is not JSON.
 */
export class StreamError extends ActionError {
  override name = "StreamError";
}

/** More records of a stream were rejected than the step allows (`maxRejected`). */
export class RejectedError extends ActionError {
  override name = "RejectedError";
}

/**
 * The state of the step cannot be read or written: not JSON, over 32 KiB, or
 * not kept for this action (`state: true`).
 */
export class StateError extends ActionError {
  override name = "StateError";
}

/** A message was not sent: invalid URL or message, connection, TLS, or a refusal of the server. */
export class SmtpError extends ActionError {
  override name = "SmtpError";
}

/** An HTTP request failed: invalid URL, connection, TLS, redirect or response too large. */
export class HttpError extends ActionError {
  override name = "HttpError";
}

/** The schema of a stream's records is not one the libraries for actions read. */
export class SchemaError extends ActionError {
  override name = "SchemaError";

  constructor(
    /** The place of the schema at fault, a JSON Pointer. */
    readonly at: string,
    /** The keyword at fault; empty when the schema is not an object. */
    readonly keyword: string,
    why: string,
  ) {
    super(keyword === "" ? `schema ${at || "/"}: ${why}` : `schema ${at || "/"}: ${keyword}: ${why}`);
  }
}
