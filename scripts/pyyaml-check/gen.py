import yaml, random, json, datetime, sys
random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
cur = ["on","off","yes","no","y","n","Y","N","true","True","FALSE","null","Null","NULL","~","","0755","0x1F","0b101","0o17","1:20","190:20:30","1:20.5","1_000","1e3","1.5e3","1.5e+3","1.e-3",".5",".inf","-.inf",".nan",".NaN","+.INF","2026-09-25","2026-9-5 1:02:03","2026-09-25T10:00:00Z","2026-09-25 10:00:00.5 +02:00","=","<<","-","123","-0","+1","012","08","09.5","0.","- x",": x","#x","@x","`x","*x","&x","!x","%x","'q'",'"dq"',"a: b","a #b"," lead","trail ","multi\nline","tab\there","\t","é","😀","a b","x\x85y","[a]","{a}","a,b","?","? x","|",">","---","...","--- x","\\","\\n","0x_","0b_","1__0","_1","1_","0_","00","-00","0:0","1:60","1:5:9",".","-.",".e+3","1.0e3","12e+3"]
alpha = list("yYnNoOfFtTeEaxlsru0123456789._:-+~=<#' \"\n\t!&*[]{},?|>%@`\\é") + [" ", "\x85", "😀"]
rnd = set()
while len(rnd) < 4000:
    rnd.add("".join(random.choice(alpha) for _ in range(random.randint(0, 7))))
num = set()
while len(num) < 3000:
    parts = [random.choice(["", "-", "+"]), random.choice(["", "0", "1", "12", "0x", "0b", "07", "1_0", "."]),
             random.choice(["", "0", "5", "_", "9", "a", "F"]), random.choice(["", ".", ".5", ":30", ":5", "e3", "e+3", "E-2", "_"]),
             random.choice(["", "0", ":59", "e+1", "."])]
    num.add("".join(parts))
strings = cur + sorted(rnd) + sorted(num)
typed = [True, False, None, 0, 7, -3, 10**20, -(2**63), 0.5, 1.0, -2.0, 1e21, 1.5e-7, 1e300, float("inf"), float("-inf"), float("nan"),
         datetime.date(2026, 9, 25), datetime.datetime(2026, 9, 25, 10, 0, 0), datetime.datetime(2026, 9, 25, 10, 0, 0, 500000)]
doc = {"s": strings, "t": typed, "k": {s: i for i, s in enumerate(strings) if not any(c in s for c in "\n\x85\u2028")}, "nested": {"a": {"b": [{"c": s} for s in cur]}}}
BRK = (chr(0x85), chr(0x2028), chr(0x2029))
for au in (False, True):
    ss = strings if not au else [x for x in strings if not any(c in x for c in BRK)]
    d = {"s": ss, "t": typed, "k": {x: i for i, x in enumerate(ss) if chr(10) not in x and not any(c in x for c in BRK)}, "nested": {"a": {"b": [{"c": x} for x in cur if x in ss]}}}
    open(f"src_{int(au)}.yaml", "w", encoding="utf-8").write(yaml.safe_dump(d, allow_unicode=au, sort_keys=True))
json.dump(strings, open("strings.json", "w"), ensure_ascii=True)
print(len(strings), "strings")
