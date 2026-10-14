import yaml, json, math, datetime
strings = json.load(open("strings.json"))
def tag(v):
    if v is None: return ["null"]
    if isinstance(v, bool): return ["bool", v]
    if isinstance(v, int): return ["num", str(v)] if abs(v) <= 2**53 - 1 else ["int", str(v)]
    if isinstance(v, float):
        if math.isnan(v): return ["float", "nan"]
        if math.isinf(v): return ["num", "inf" if v > 0 else "-inf"]
        return ["num", None, v]
    if isinstance(v, str): return ["str", v]
    if isinstance(v, (datetime.date, datetime.datetime)): return ["ts"]
    if isinstance(v, list): return [tag(x) for x in v]
    return {str(k) if not isinstance(k, bool) else ("true" if k else "false"): tag(x) for k, x in v.items()}
def eq_tag(a, b):
    if isinstance(a, dict): return isinstance(b, dict) and a.keys() == b.keys() and all(eq_tag(a[k], b[k]) for k in a)
    if isinstance(a, list) and a and isinstance(a[0], (list, dict)) or (isinstance(a, list) and not a): return isinstance(b, list) and len(a) == len(b) and all(eq_tag(x, y) for x, y in zip(a, b))
    if a[0] == "num" and len(a) == 3: return b[0] == "num" and float(b[1]) == a[2]
    return a == b
def diff(a, b, path, out):
    if type(a) != type(b) or (isinstance(a, float) and not (a == b or (math.isnan(a) and math.isnan(b)))) or (not isinstance(a, (dict, list, float)) and a != b):
        out.append((path, repr(a)[:60], repr(b)[:60])); return
    if isinstance(a, dict):
        if a.keys() != b.keys(): out.append((path, "keys", sorted(set(map(repr, a)) ^ set(map(repr, b)))[:6])); return
        for k in a: diff(a[k], b[k], f"{path}.{k!r}"[:80], out)
    elif isinstance(a, list):
        if len(a) != len(b): out.append((path, len(a), len(b))); return
        for i, (x, y) in enumerate(zip(a, b)): diff(x, y, f"{path}[{i}]", out)
import sys
for LN, LDR in (("SafeLoader", yaml.SafeLoader), ("CSafeLoader", yaml.CSafeLoader)):
    LOAD = lambda f, L=LDR: yaml.load(f, Loader=L)
    print("== loader", LN)
    for au in (0, 1):
        orig = LOAD(open(f"src_{au}.yaml", encoding="utf-8"))
        parsed = json.load(open(f"parsed_{au}.json"))
        bad = []
        def walk(o, p, path):
            if isinstance(o, dict):
                if not isinstance(p, dict) or set(map(lambda k: tag(k)[1] if not isinstance(k, str) else k, o)) and False: pass
                for k, x in o.items():
                    kk = "true" if k is True else "false" if k is False else str(k)
                    if kk not in p: bad.append((path, "missing key", repr(k))); continue
                    walk(x, p[kk], f"{path}.{kk!r}"[:80])
            elif isinstance(o, list):
                for i, x in enumerate(o): walk(x, p[i], f"{path}[{i}]")
            else:
                t = tag(o)
                if not eq_tag(t, p): bad.append((path, t, p))
        walk(orig, parsed, "")
        print(f"[au={au}] 1 parse fidelity: {len(bad)} mismatches", bad[:8])
        out = []
        try:
            diff(orig, LOAD(open(f"doc_{au}.yaml", encoding="utf-8")), "", out)
            print(f"[au={au}] 2 in-place round trip: {len(out)} mismatches", out[:8])
        except Exception as e: print(f"[au={au}] 2 in-place round trip: PyYAML FAILED: {e}"[:300])
        out = []
        try:
            merged = LOAD(open(f"merged_{au}.yaml", encoding="utf-8"))
            if merged.pop("platform_toolsets", None) != {"cli": ["file"]}: out.append(("platform_toolsets", "not set", ""))
            diff(orig, merged, "", out)
            print(f"[au={au}] 2b mergeConfig edit: {len(out)} mismatches", out[:8])
        except Exception as e: print(f"[au={au}] 2b mergeConfig edit: PyYAML FAILED: {e}"[:300])
    out = []
    try:
        fresh = LOAD(open("fresh.yaml", encoding="utf-8"))
        diff(strings, fresh["s"], "s", out); diff({s: i for i, s in enumerate(strings) if not any(c in s for c in "\n\x85\u2028")}, fresh["k"], "k", out)
        diff([0.5, 1e21, 1.5e-7, 12, -3, True, None], fresh["n"], "n", out)
        print(f"3 fresh stringify: {len(out)} mismatches", out[:8])
    except Exception as e: print(f"3 fresh stringify: PyYAML FAILED: {e}"[:300])
