"""JSON values, checked once."""

import pytest

from cronplane_actions._json import checked, parse


def test_only_json_values_pass() -> None:
    assert parse('{"a": [1, 2.5, true, null, "x"]}') == {"a": [1, 2.5, True, None, "x"]}
    with pytest.raises(TypeError, match="a JSON object key is a string, not 1"):
        checked({1: "a"})
    with pytest.raises(TypeError, match="not a JSON value: set"):
        checked([{1, 2}])
