#!/usr/bin/env python3
"""Generate Autofill Guard policy templates.

Usage:  python3 tools/gen_policy_templates.py [extension-id] [output-dir]

The extension ID defaults to the one derived from the "key" in extension/manifest.json.
Pass an explicit ID when deploying a web-store build (stores assign their own ID).

Writes ADMX/ADML (Chrome + Edge), example .reg files, Linux JSON and macOS .mobileconfig
profiles. Output is deterministic so CI can check that committed templates are current.
"""
import base64
import hashlib
import json
import os
import re
import sys
import uuid
from xml.sax.saxutils import escape

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def id_from_manifest():
    manifest = json.load(open(os.path.join(ROOT, "extension", "manifest.json")))
    if "key" not in manifest:
        sys.exit("manifest.json has no \"key\"; pass the extension ID explicitly.")
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


EXT_ID = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else id_from_manifest()
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "policy")
if not re.fullmatch(r"[a-p]{32}", EXT_ID):
    sys.exit(f"Not a valid extension ID: {EXT_ID}")

BROWSERS = {
    "chrome": {
        "name": "Google Chrome",
        "reg": r"Software\Policies\Google\Chrome",
        "mac_domain": "com.google.Chrome",
        "linux_dir": "/etc/opt/chrome/policies/managed",
    },
    "edge": {
        "name": "Microsoft Edge",
        "reg": r"Software\Policies\Microsoft\Edge",
        "mac_domain": "com.microsoft.Edge",
        "linux_dir": "/etc/opt/edge/policies/managed",
    },
}

SCHEMA = json.load(open(os.path.join(ROOT, "extension", "schema.json")))["properties"]
LISTS = [k for k, v in SCHEMA.items() if v["type"] == "array"]
BOOLS = [k for k, v in SCHEMA.items() if v["type"] == "boolean"]

EXAMPLE = {
    "MandatorySites": ["examplebank.com", "=hr.example.com"],
    "RecommendedSites": ["example-vendor.com"],
    "AllowUserSites": True,
    "AllowDisablingRecommended": True,
    "BlockAutocomplete": True,
    "BlockAutofill": True,
    "BlockPasswords": False,
}


def ensure(path):
    os.makedirs(path, exist_ok=True)
    return path


def write(path, text, encoding="utf-8"):
    with open(path, "w", encoding=encoding, newline="\r\n" if path.endswith((".reg", ".admx", ".adml")) else "\n") as f:
        f.write(text)


def policy_key(browser):
    return BROWSERS[browser]["reg"] + rf"\3rdparty\extensions\{EXT_ID}\policy"


# ---------------------------------------------------------------- ADMX / ADML

def admx():
    cats, pols = [], []
    for b, info in BROWSERS.items():
        cat = f"AutofillGuard_{b}"
        cats.append(f'    <category name="{cat}" displayName="$(string.{cat})"/>')
        key = policy_key(b)
        for name in LISTS:
            pid = f"{b}_{name}"
            pols.append(f'''    <policy name="{pid}" class="Machine" displayName="$(string.{name})" explainText="$(string.{name}_Explain)" presentation="$(presentation.{pid})" key="{key}">
      <parentCategory ref="{cat}"/>
      <supportedOn ref="SUPPORTED_AFG"/>
      <elements>
        <list id="{name}_List" key="{key}\\{name}" valuePrefix=""/>
      </elements>
    </policy>''')
        for name in BOOLS:
            pid = f"{b}_{name}"
            pols.append(f'''    <policy name="{pid}" class="Machine" displayName="$(string.{name})" explainText="$(string.{name}_Explain)" key="{key}" valueName="{name}">
      <parentCategory ref="{cat}"/>
      <supportedOn ref="SUPPORTED_AFG"/>
      <enabledValue><decimal value="1"/></enabledValue>
      <disabledValue><decimal value="0"/></disabledValue>
    </policy>''')
    return f'''<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="autofillguard" namespace="AutofillGuard.Policies.{EXT_ID}"/>
  </policyNamespaces>
  <resources minRequiredRevision="1.0"/>
  <supportedOn>
    <definitions>
      <definition name="SUPPORTED_AFG" displayName="$(string.SUPPORTED_AFG)"/>
    </definitions>
  </supportedOn>
  <categories>
    <category name="AutofillGuard" displayName="$(string.AutofillGuard)"/>
{chr(10).join(c.replace("/>", '><parentCategory ref="AutofillGuard"/></category>') for c in cats)}
  </categories>
  <policies>
{chr(10).join(pols)}
  </policies>
</policyDefinitions>
'''


def adml():
    strings = {
        "AutofillGuard": "Autofill Guard extension",
        "SUPPORTED_AFG": f"Autofill Guard extension ({EXT_ID}) on Chromium-based browsers",
    }
    for b, info in BROWSERS.items():
        strings[f"AutofillGuard_{b}"] = info["name"]
    fmt = (
        "\n\nEntry formats:\n"
        "  example.com            example.com and all subdomains\n"
        "  =login.example.com     that exact host only\n"
        "  https://example.com    https only (http:// likewise)\n"
        "  10.0.0.5 / intranet    IPs and single-label names match exactly\n"
        "Ports and paths are ignored."
    )
    for name, spec in SCHEMA.items():
        strings[name] = spec["title"]
        strings[f"{name}_Explain"] = spec["description"] + (fmt if spec["type"] == "array" else "") + \
            f"\n\nExtension ID: {EXT_ID}"
    pres = []
    for b in BROWSERS:
        for name in LISTS:
            pres.append(f'''      <presentation id="{b}_{name}">
        <listBox refId="{name}_List">Sites:</listBox>
      </presentation>''')
    s = "\n".join(f'      <string id="{k}">{escape(v)}</string>' for k, v in strings.items())
    return f'''<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>Autofill Guard</displayName>
  <description>Policies for the Autofill Guard browser extension</description>
  <resources>
    <stringTable>
{s}
    </stringTable>
    <presentationTable>
{chr(10).join(pres)}
    </presentationTable>
  </resources>
</policyDefinitionResources>
'''


# ---------------------------------------------------------------- .reg

def reg(browser):
    key = "HKEY_LOCAL_MACHINE\\" + policy_key(browser)
    lines = ["Windows Registry Editor Version 5.00", "",
             f"; Autofill Guard policy for {BROWSERS[browser]['name']} (example values - edit before use)",
             f"[-{key}]", "", f"[{key}]"]
    for name in BOOLS:
        if name in EXAMPLE:
            lines.append(f'"{name}"=dword:{int(EXAMPLE[name]):08x}')
    for name in LISTS:
        lines += ["", f"[{key}\\{name}]"]
        for i, v in enumerate(EXAMPLE[name], 1):
            lines.append(f'"{i}"="{v}"')
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- Linux

def linux(browser):
    return json.dumps({"3rdparty": {"extensions": {EXT_ID: EXAMPLE}}}, indent=2) + "\n"


# ---------------------------------------------------------------- macOS

def plist_value(v, indent):
    pad = "\t" * indent
    if isinstance(v, bool):
        return f"{pad}<{'true' if v else 'false'}/>"
    if isinstance(v, str):
        return f"{pad}<string>{escape(v)}</string>"
    if isinstance(v, list):
        return f"{pad}<array>\n" + "\n".join(plist_value(x, indent + 1) for x in v) + f"\n{pad}</array>"
    if isinstance(v, dict):
        body = "\n".join(f"{pad}\t<key>{escape(k)}</key>\n{plist_value(x, indent + 1)}" for k, x in v.items())
        return f"{pad}<dict>\n{body}\n{pad}</dict>"
    raise TypeError(v)


def mobileconfig(browser):
    info = BROWSERS[browser]
    domain = f"{info['mac_domain']}.extensions.{EXT_ID}"
    inner = {
        "PayloadType": domain,
        "PayloadVersion": 1,
        "PayloadIdentifier": f"autofillguard.{browser}.{EXT_ID}",
        "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_URL, f"afg-inner-{browser}-{EXT_ID}")).upper(),
        "PayloadDisplayName": f"Autofill Guard ({info['name']})",
        **EXAMPLE,
    }
    outer = {
        "PayloadContent": [inner],
        "PayloadDisplayName": f"Autofill Guard policy ({info['name']})",
        "PayloadIdentifier": f"autofillguard.profile.{browser}",
        "PayloadType": "Configuration",
        "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_URL, f"afg-outer-{browser}-{EXT_ID}")).upper(),
        "PayloadVersion": 1,
        "PayloadScope": "System",
    }

    def fix_ints(s):  # PayloadVersion must be <integer>
        return re.sub(r"<key>PayloadVersion</key>\n(\t*)<string>1</string>", r"<key>PayloadVersion</key>\n\1<integer>1</integer>", s)

    outer_s = plist_value({k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v) for k, v in outer.items()
                           if k != "PayloadContent"}, 0)
    inner_s = plist_value({k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v) for k, v in inner.items()}, 2)
    body = outer_s.replace("<dict>\n", "<dict>\n\t<key>PayloadContent</key>\n\t<array>\n" + inner_s + "\n\t</array>\n", 1)
    return fix_ints('<?xml version="1.0" encoding="UTF-8"?>\n'
                    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
                    f'<plist version="1.0">\n{body}\n</plist>\n')


# ---------------------------------------------------------------- write

win = ensure(os.path.join(OUT, "windows"))
write(os.path.join(win, "AutofillGuard.admx"), admx())
write(os.path.join(ensure(os.path.join(win, "en-US")), "AutofillGuard.adml"), adml())
for b in BROWSERS:
    write(os.path.join(win, f"example-{b}.reg"), reg(b))
    write(os.path.join(ensure(os.path.join(OUT, "linux")), f"autofill-guard-{b}.json"), linux(b))
    write(os.path.join(ensure(os.path.join(OUT, "macos")), f"AutofillGuard-{b}.mobileconfig"), mobileconfig(b))
print(f"Templates written to {os.path.relpath(OUT)} for extension {EXT_ID}")
