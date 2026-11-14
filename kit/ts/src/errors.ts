/** A step cannot be built: something the action must give is missing. */
export class StepError extends Error {
  override name = "StepError";
}
