"""Write Cronplane actions in Python.

```python
from cronplane_actions import Action

action = Action.from_environment()
token = action.http.post_json(action.inputs.string("url"), {"name": "x"}).json()
action.mask(token_value)
action.outputs.set("id", 42)
```
"""

from ._action import MAX_OUTPUT_BYTES, Action, Inputs, Network, Outputs, Scalar
from ._errors import (
    ActionError,
    EgressError,
    HttpError,
    InputError,
    OutputError,
    RejectedError,
    SchemaError,
    SecretError,
    StateError,
    StreamError,
    VersionError,
)
from ._http import Egress, HttpClient, Response, is_public
from ._json import JsonValue
from ._network import AllowedHosts
from ._schema import Problem, RecordSchema
from ._state import MAX_STATE_BYTES, State
from ._streams import StreamReader, Streams, StreamWriter
from ._version import REQUIRES_CRONPLANE

__all__ = [
    "MAX_OUTPUT_BYTES",
    "MAX_STATE_BYTES",
    "REQUIRES_CRONPLANE",
    "Action",
    "ActionError",
    "AllowedHosts",
    "Egress",
    "EgressError",
    "HttpClient",
    "HttpError",
    "InputError",
    "Inputs",
    "JsonValue",
    "Network",
    "OutputError",
    "Outputs",
    "Problem",
    "RecordSchema",
    "RejectedError",
    "Response",
    "Scalar",
    "SchemaError",
    "SecretError",
    "State",
    "StateError",
    "StreamError",
    "StreamReader",
    "StreamWriter",
    "Streams",
    "VersionError",
    "is_public",
]
