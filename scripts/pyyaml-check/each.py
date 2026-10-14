import yaml, json
strings = json.load(open("strings.json"))
docs = []
for s in strings:
    for au in (False, True):
        v = yaml.safe_dump({"s": [s]}, allow_unicode=au); k = yaml.safe_dump({s: 1}, allow_unicode=au)
        docs.append({"s": s, "au": au, "v": v, "k": k, "ref_v": yaml.safe_load(v)["s"][0], "ref_k": list(yaml.safe_load(k))[0], "cref_v": yaml.load(v, Loader=yaml.CSafeLoader)["s"][0], "cref_k": list(yaml.load(k, Loader=yaml.CSafeLoader))[0]})
json.dump(docs, open("each.json", "w"))

print("PyYAML self-roundtrip differences:", sum(d["ref_v"] != d["s"] for d in docs), sum(d["ref_k"] != d["s"] for d in docs), "au=True only:", all(d["au"] for d in docs if d["ref_v"] != d["s"]))
print("SafeLoader vs CSafeLoader disagree on:", sum(d["ref_v"] != d["cref_v"] or d["ref_k"] != d["cref_k"] for d in docs), "of", len(docs))
