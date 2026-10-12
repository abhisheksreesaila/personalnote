# Document fixtures

Notes in the old canvas engine's format (Fabric.js 7.4 JSON, `{ name, description, content, pageState }`). They are the input of the
one-time conversion to JSON Canvas (`fromFabric` in `src/core/document/legacy-fabric.js`, `from_fabric` in `document_model.py`), and
the tests check the model they give against what Fabric itself did (`../fabric-oracle.json`).

They are frozen. Most were generated once with Fabric's own classes by `scripts/generate-document-fixtures.mjs`, which needed the
Fabric library and was removed with it (F-036); the last commit that still has the script and the library is `e7586c3` on the
`leafer` branch. `cli-created.json` and `cli-appended.json` come from `scripts/generate_cli_fixture.py`, which builds on the others.
If a fixture has to change, edit the JSON by hand and refresh `../fabric-oracle.json` only if you can measure it with Fabric from that
commit; otherwise add a new fixture whose expected points you can check some other way.
