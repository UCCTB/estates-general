// Node 端的房间仓库：内存 Map + 每次变更写一份 JSON 存档。
// 存档是 Room.toJSON() 的全量快照，所以服务端重启后再有人点开旧链接，
// 房间会从磁盘还原（令牌本身没变，nonce 也在存档里）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Room, setRoomStore, type RoomData, type RoomStore } from './room.js';

export function installFsStore(dataDir = process.env['ESTATES_DATA_DIR'] ?? 'data'): void {
  const live = new Map<string, Room>();
  const file = (gameId: string) => join(dataDir, `${gameId}.json`);

  const store: RoomStore = {
    get(gameId, secret) {
      const hit = live.get(gameId);
      if (hit !== undefined) return hit;
      try {
        const d = JSON.parse(readFileSync(file(gameId), 'utf8')) as RoomData;
        const room = Room.restore(d, secret);
        live.set(gameId, room);
        return room;
      } catch {
        return undefined;   // 没这局，或存档读不出来
      }
    },
    put(room) {
      live.set(room.gameId, room);
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(file(room.gameId), JSON.stringify(room.toJSON()), 'utf8');
      } catch {
        // 持久化失败不影响进行中的一局；主持端仍有完整的内存状态
      }
    },
    list: () => [...live.values()],
  };

  setRoomStore(store);
}
