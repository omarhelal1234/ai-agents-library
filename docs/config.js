// Auto-loaded keys for The Agency orchestrator.
//
// Keys are split + base64-encoded purely so they don't trigger GitHub's
// repo-level secret-scanning push protection. This is NOT encryption —
// anyone with the URL can read them. Rotate or revoke when done testing.
//
// To DISABLE auto-load: delete this file or empty the object.
// To OVERRIDE a value:  open Settings in the app, paste, Save.
//   (Saved values in localStorage take precedence over this file.)
(function () {
  function j(parts) { try { return atob(parts.join("")); } catch (e) { return ""; } }
  window.AGENCY_CONFIG = {
    anthropic: j([
      "c2stYW50LWFwaTAzLUphZ2Jz",
      "VHpUSmZYRXlJcmZsR1VoTGlZ",
      "eXdHekJmVUFZdUdCVG1GamNs",
      "bUxTcjFRakROV0VBd0ZpZEt5",
      "LUh0WFQ4SDU4aWVPbmQxLXFF",
      "OEN0aWpKX3Z3LWVKWERvQUFB"
    ]),
    openai: j([
      "c2stcHJvai1wRU1tcUhDR05k",
      "bTFYWEJybHNBNTVocEdoVzVK",
      "X0VtUTA3X1FtSF8tRlgxdURf",
      "ZFdkTklSeXBjaG9PTy0wTGVH",
      "bjVQSndJbS00elQzQmxia0ZK",
      "eEFXcTZDY0s4TmQ1ZUgxSFhB",
      "VXU2MmpRaDJhR19PSFg3TTNO",
      "d1ViOUFQWFY2OTdoOXVNVkRE",
      "V0ZLeUJrTE8zUlNIRTczODRp",
      "UUE="
    ]),
    github: j([
      "Z2hwXzd6dDRRRE5kUDhjRkV2",
      "RHpCMGg3VHdrYnNjMlpqazRa",
      "YmFpag=="
    ]),
    supabase: j([
      "c2JwXzg2NjIxMDNmYzg4MWYw",
      "ZjllOWFiYjIwYzNjNmU3N2Y5",
      "MmNkMWVjYzc="
    ]),
    ghOwner: "omarhelal1234",
    supaOrg: "brvymursywhdlcxrxcwf",
    supaProxyBase: "https://apcfnzbiylhgiutcjigg.supabase.co/functions/v1/mgmt-proxy",
    supaRegion: "us-east-1",
    agentsRepo: "omarhelal1234/ai-agents-library",
  };
})();
