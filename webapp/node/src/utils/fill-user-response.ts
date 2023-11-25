import { createHash } from "node:crypto";
import { PoolConnection, RowDataPacket } from "mysql2/promise";
import { IconModel, ThemeModel, UserModel } from "../types/models";
import { userImageBasefilePath } from "../handlers/user-handler";
import { readFileSync } from "node:fs";

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

  let image;
  try {
    const filePath = userImageBasefilePath(user.id);
    image = readFileSync(filePath).buffer;
  } catch (error) {}

  if (!image) {
    image = await getFallbackUserIcon();
  }

  return {
    id: user.id,
    name: user.name,
    display_name: user.display_name,
    description: user.description,
    theme: {
      id: user.id,
      // dark_mode: !!theme.dark_mode,
      dark_mode: user.dark_mode,
    },
    icon_hash: createHash("sha256").update(new Uint8Array(image)).digest("hex"),
  } satisfies UserResponse;
};
