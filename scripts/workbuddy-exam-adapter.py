"""Local offline adapter to the installed WorkBuddy ACP bridge. No credentials stored."""
import asyncio, json, os, pathlib, sys
from workbuddy_acp_bridge.acp_client import discover_client
from workbuddy_acp_bridge.server import _load_default_model_id

async def main():
    client = discover_client(permission_mode='deny')
    try:
        result = await client.run(sys.stdin.read(), cwd=pathlib.Path(os.getcwd()),
                                  model_id=_load_default_model_id(), timeout_seconds=600)
        print(json.dumps({'service':'WorkBuddy ACP','result':result.to_dict(),
                          'cost':None,'cost_note':'ACP does not expose billing usage'}))
    finally:
        await client.close()

asyncio.run(main())
