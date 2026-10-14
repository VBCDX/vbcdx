"""Writes test/fixtures/hermes-webui-save.{yaml,json}.

The .yaml is a profile config.yaml as Hermes Web UI saves it (api/config.py:
yaml.safe_dump(config, sort_keys=False, allow_unicode=True)), holding values on
which PyYAML and YAML 1.2 disagree. The .json is what PyYAML reads from it, with
types: ["str", v], ["bool", v], ["null"], ["int", "digits"], ["float", v | "nan" |
"inf" | "-inf"], ["timestamp"]. Both SafeLoader (Web UI) and CSafeLoader (agent) must
agree. Regenerate with the PyYAML Hermes ships: python3 scripts/pyyaml-check/fixture.py
"""
import datetime, json, math, os, yaml

TRICKY = ["on", "off", "yes", "no", "y", "n", "Y", "N", "true", "True", "FALSE", "null", "~", "",
          "0755", "0x1F", "0b101", "0o17", "1:20", "190:20:30", "08:30", "22:00", "09", "08540", "1_000", "1e3", "1e-5", "1.5e3", "1.5e+3", ".5", "1.10", "5m",
          ".inf", ".nan", "2026-09-25", "2026-09-25 10:00:00", "=", "<<", "-", "123", "1.0", "+1", "012", "08",
          "#x", "- x", "a: b", "a #b", " lead", "trail ", "multi\nline", " \n", "tab\there", "\x7f", "\x01",
          "'q'", '"dq"', "é", "😀", "\\", "@x", "%x", "!x", "&x", "*x", "[a]", "{a}", "a,b", "?"]
config = {
    "platform_toolsets": {"cli": ["file", "todo"], "telegram": ["file"]},
    "agent": {"disabled_toolsets": ["browser"], "reasoning_effort": "high", "coding_context": "off",
              "max_turns": 60, "temperature": 1.0, "top_p": 0.95},
    "model": {"provider": "custom:litellm", "base_url": "https://llm.example/v1", "default": "old-model"},
    "display": {"memory_notifications": "on", "tool_progress": "off", "bell": True, "theme": "y", "compact": "n"},
    "operator": {
        "strings": TRICKY,
        "keys": {s: i for i, s in enumerate(TRICKY) if "\n" not in s},
        "typed": [True, False, None, 0, 7, -3, 10**20, 0.5, 1.0, -2.0, 1e21, 1.5e-7, float("inf"), float("-inf"),
                  float("nan"), datetime.date(2026, 9, 25), datetime.datetime(2026, 9, 25, 10, 0, 0)],
    },
}
text = yaml.safe_dump(config, sort_keys=False, allow_unicode=True)

def tag(v):
    if v is None: return ["null"]
    if isinstance(v, bool): return ["bool", v]
    if isinstance(v, int): return ["int", str(v)]
    if isinstance(v, float):
        return ["float", "nan" if math.isnan(v) else "inf" if v == math.inf else "-inf" if v == -math.inf else v]
    if isinstance(v, str): return ["str", v]
    if isinstance(v, (datetime.date, datetime.datetime)): return ["timestamp"]
    if isinstance(v, list): return [tag(x) for x in v]
    assert all(isinstance(k, str) for k in v), "only string keys"
    return {k: tag(x) for k, x in v.items()}

py, c = tag(yaml.load(text, Loader=yaml.SafeLoader)), tag(yaml.load(text, Loader=yaml.CSafeLoader))
assert py == c, "SafeLoader and CSafeLoader disagree"
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "test", "fixtures")
open(os.path.join(out, "hermes-webui-save.yaml"), "w", encoding="utf-8").write(text)
open(os.path.join(out, "hermes-webui-save.json"), "w", encoding="utf-8").write(
    json.dumps({"pyyaml": yaml.__version__, "libyaml": yaml.__with_libyaml__, "loaded": py}, ensure_ascii=False, indent=1) + "\n")
print("PyYAML", yaml.__version__, "libyaml", yaml.__with_libyaml__, "->", out)
