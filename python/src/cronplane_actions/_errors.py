"""The errors of the library: each says what the action cannot do and why."""


class ActionError(Exception):
    """The action cannot go on: wrong environment, input, output, secret or request."""


class VersionError(ActionError):
    """The Cronplane that runs the step is older than this library needs, or of
    another major version."""


class InputError(ActionError):
    """An input of the action is missing or not of the type asked for."""


class OutputError(ActionError):
    """An output cannot be written: not JSON, or over the size Cronplane accepts."""


class SecretError(ActionError):
    """A secret of the action is not given to the step."""


class EgressError(ActionError):
    """An address the worker forbids its steps to reach (`CRONPLANE_EGRESS=public`), a
    host out of those the step may reach (`CRONPLANE_NETWORK_ALLOW`), or a host reached
    in clear that is neither this machine nor one the step names
    (`CRONPLANE_NETWORK_PLAIN`)."""


class StreamError(ActionError):
    """A stream cannot be written or read: its name, its schema.json, its parts or
    a line that is not JSON."""


class RejectedError(ActionError):
    """More records of a stream were rejected than the step allows (`max_rejected`)."""


class StateError(ActionError):
    """The state of the step cannot be read or written: not JSON, over 32 KiB, or
    not kept for this action (`state: true`)."""


class SmtpError(ActionError):
    """A message was not sent: invalid URL or message, connection, TLS, or a refusal
    of the server."""


class HttpError(ActionError):
    """An HTTP request failed: invalid URL, connection, TLS, redirect or response too large."""


class SchemaError(ActionError):
    """The schema of a stream's records is not one the libraries for actions read."""

    def __init__(self, at: str, keyword: str, why: str) -> None:
        super().__init__(
            f"schema {at or '/'}: {keyword}: {why}" if keyword else f"schema {at or '/'}: {why}"
        )
        #: The place of the schema at fault, a JSON Pointer.
        self.at = at
        #: The keyword at fault; empty when the schema is not an object.
        self.keyword = keyword
