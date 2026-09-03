"""Does this machine's package index actually have what we need?

Run on the target machine. Uses only the standard library, so it works before installing anything.
Actually downloads each wheel rather than querying metadata, because a corporate mirror can list a
package and still fail to serve a wheel for your platform.
"""
import platform, shutil, subprocess, sys, sysconfig, tempfile

REQUIRED = ["onnxruntime", "numpy"]
OPTIONAL = [
    ("tokenizers", "faster tokenizer; bench/minbpe.py replaces it using the stdlib alone"),
    ("huggingface_hub", "convenient model download; plain HTTPS works instead"),
]

def index_url():
    try:
        out = subprocess.run([sys.executable, "-m", "pip", "config", "list"],
                             capture_output=True, text=True, timeout=60).stdout
        hits = [l for l in out.splitlines() if "index-url" in l]
        return "; ".join(hits) if hits else "not configured (would use pypi.org)"
    except Exception as e:
        return f"could not read pip config: {e}"

def try_download(pkg):
    d = tempfile.mkdtemp()
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:", "-d", d, pkg],
            capture_output=True, text=True, timeout=900)
        if r.returncode == 0:
            import os
            files = os.listdir(d)
            return True, (files[0] if files else "downloaded")
        tail = [l for l in (r.stderr or r.stdout).strip().splitlines() if l.strip()]
        return False, (tail[-1][:180] if tail else "failed")
    except Exception as e:
        return False, str(e)[:180]
    finally:
        shutil.rmtree(d, ignore_errors=True)

def main():
    print(f"python      {platform.python_version()} ({platform.machine()}, {sys.platform})")
    print(f"wheel tag   {sysconfig.get_platform()}")
    print(f"pip index   {index_url()}")
    print()

    missing = []
    for pkg in REQUIRED:
        ok, detail = try_download(pkg)
        print(f"{'OK  ' if ok else 'MISS'}  {pkg:<18} {detail}")
        if not ok:
            missing.append(pkg)
    for pkg, why in OPTIONAL:
        ok, detail = try_download(pkg)
        print(f"{'OK  ' if ok else 'skip'}  {pkg:<18} {detail if ok else 'not available — ' + why}")

    print()
    if missing:
        print(f"BLOCKED: {', '.join(missing)} unavailable. Both are required and have no pure-Python")
        print("substitute. Options: ask for them in Artifactory, or download the wheel matching the")
        print(f"tag above on a connected machine and `pip install <file>.whl` (no compiler needed).")
        return 1
    print("Everything required is available. onnxruntime and numpy are enough;")
    print("bench/minbpe.py covers tokenisation with no further packages.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
