# tonearmd-mcp

An MCP server that lets Claude read your Roon state, search your library, and
put music on — by talking to [tonearm](https://github.com/ssandys/tonearm)'s
daemon.

## Requires a running tonearmd

This server has **no Roon credentials of its own** and never talks to Roon
directly. `tonearmd` owns the only Roon connection, which is what keeps Roon
pairing to a single approval. Install and pair tonearm first; this server
connects to its unix socket at `$XDG_RUNTIME_DIR/tonearm/sock`.

## Install

```bash
git clone https://github.com/ssandys/tonearmd-mcp.git
cd tonearmd-mcp
npm install
```

Then point your MCP client at it:

```json
{
  "mcpServers": {
    "tonearm": {
      "command": "node",
      "args": ["/absolute/path/to/tonearmd-mcp/src/server.js"]
    }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `tonearm_status` | — | What is playing, and which zones exist |
| `tonearm_search` | `query` | Albums and tracks matching the query, each with a `ref` |
| `tonearm_play` | `ref` | Plays a search result in the followed zone |
| `tonearm_control` | `action` | `playpause`, `pause`, `next`, `previous` |
| `tonearm_transfer` | `to_zone` | Moves what is playing to another zone, keeping position |
| `tonearm_pin` | `zone` \| `unpin` | Changes which zone the bar widget follows |

Play and transport act on the zone the widget is following. To put music in a
different room, play it and then `tonearm_transfer` it there.

## How search works

A Roon search does not return albums — it returns category rows (`Artists`,
`Albums`, `Composers`, `Tracks`, `Works`). This server descends into `Albums`
and `Tracks`, capped at ten each, and returns a flat list of candidates so
Claude can pick rather than guess.

Each candidate carries an opaque `ref` encoding the walk that found it. Playing
one re-runs that walk rather than holding a browse cursor open, because a
Claude turn can take minutes and a held cursor goes stale. The ref also records
the title it was minted with, and playing refuses if the row at that position
no longer matches — so a shifted result is an error you can see, never a
different album playing quietly.

## Running the tests

```bash
npm test
```

46 tests, no network and no daemon required — the fixtures are real daemon
replies captured from a live Roon Core.

## License

MIT. The only dependencies are `@modelcontextprotocol/sdk` and `zod`.
