import { createHash } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { IconModel, ThemeModel, UserModel } from "../types/models";
import { userImageBasefilePath } from "../handlers/user-handler";
import { readFileSync, existsSync } from "node:fs";
import {
  fallbackUserIconHashStatic,
  fallbackUserIconStatic,
  rds,
} from "../main";

export interface UserResponse {
  id: number;
  name: string;
  display_name: string;
  description: string;
  theme: {
    id: number;
    dark_mode: boolean;
  };
  icon_hash: string;
}

// export interface UserModel {
//   id: number;
//   name: string;
//   display_name: string;
//   password: string;
//   description: string;
// }

export const fillUserResponse = async (
  conn: PoolConnection,
  user: Omit<UserModel, "password">,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>
) => {
  const createResponse = (hash: string) =>
    ({
      id: user.id,
      name: user.name,
      display_name: user.display_name,
      description: user.description,
      theme: {
        id: user.id,
        dark_mode: user.dark_mode,
      },
      icon_hash: hash,
    }) satisfies UserResponse;
  // 2s の物語
  // redis に hash があればそれを返す
  const hash = await rds.get(`user:${user.id}:icon_hash`);
  if (hash) {
    return createResponse(hash);
  } else {
    const imageExists = existsSync(userImageBasefilePath(user.id));
    if (imageExists) {
      const imageBuffer = readFileSync(userImageBasefilePath(user.id)).buffer;
      const hash = createHash("sha256")
        .update(new Uint8Array(imageBuffer))
        .digest("hex");
      rds.set(`user:${user.id}:icon_hash`, hash, { PX: 1500 /* ms */ });
      return createResponse(hash);
    } else {
      return createResponse(fallbackUserIconHashStatic);
    }
  }
};
