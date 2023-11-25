import { Context } from "hono";
import { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { HonoEnvironment } from "../types/application";
import {
  defaultUserIDKey,
  defaultUserNameKey,
  defaultSessionExpiresKey,
} from "../contants";
import { verifyUserSessionMiddleware } from "../middlewares/verify-user-session-middleare";
import { fillUserResponse } from "../utils/fill-user-response";
import { throwErrorWith } from "../utils/throw-error-with";
import { IconModel, UserModel } from "../types/models";

import fs = require("fs");
import path = require("path");
import os = require("os");

// ホームディレクトリの取得
const homeDirectory = os.homedir();

// GET /api/user/:username/icon
export const getIconHandler = [
  async (c: Context<HonoEnvironment, "/api/user/:username/icon">) => {
    const username = c.req.param("username");

    const conn = await c.get("pool").getConnection();
    await conn.beginTransaction();
    try {
      const [[user]] = await conn
        .query<(UserModel & RowDataPacket)[]>(
          "SELECT * FROM users WHERE name = ?",
          [username]
        )
        .catch(throwErrorWith("failed to get user"));

      if (!user) {
        await conn.rollback();
        conn.release();
        return c.text("not found user that has the given username", 404);
      }
      // get user image
      let iconFile;
      try {
        iconFile = fs.readFileSync(userImageBasefilePath(user.id));
      } catch (error: any) {
        if (error.code === "ENOENT") {
          console.error("File not found:", userImageBasefilePath(user.id));
        } else {
          console.error("Error reading file:", error.message);
        }
      }
      if (!iconFile) {
        return c.body(await c.get("runtime").fallbackUserIcon(), 200, {
          "Content-Type": "image/jpeg",
        });
      }
      return c.body(iconFile.buffer, 200, {
        "Content-Type": "image/jpeg",
      });
    } catch (error) {
      // await conn.rollback();
      return c.text(`Internal Server Error\n${error}`, 500);
    }
  },
];

export const userImageDirectoryPath = path.join(
  homeDirectory,
  "webapp",
  "user-images"
);
export const userImageBasefilePath = (userId: number): string => {
  return path.join(userImageDirectoryPath, `${userId.toString()}.jpg`);
};

function saveBase64Image(base64String: string, userID: number) {
  const decodedData = Buffer.from(base64String, "base64"); // Base64データをデコード
  console.log(base64String);

  // ファイルの保存先パスを組み立て
  const filePath = userImageBasefilePath(userID);

  // ファイルにデコードされたデータを書き込み
  fs.writeFileSync(userImageBasefilePath(userID), decodedData);
  return filePath;
}

// POST /api/icon
export const postIconHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, "/api/icon">) => {
    const userId = c.get("session").get(defaultUserIDKey) as number; // userId is verified by verifyUserSessionMiddleware

    // base64 encoded image
    const body = await c.req.json<{ image: string }>();

    try {
      saveBase64Image(body.image, userId);
      // return c.json({ id: iconId }, 201);
      return c.json({ id: userId }, 201);
    } catch (error) {
      return c.text(`Internal Server Error\n${error}`, 500);
    } finally {
    }
  },
];

// GET /api/user/me
export const getMeHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, "/api/user/me">) => {
    const userId = c.get("session").get(defaultUserIDKey) as number; // userId is verified by verifyUserSessionMiddleware

    const conn = await c.get("pool").getConnection();
    await conn.beginTransaction();

    try {
      const [[user]] = await conn
        .query<(UserModel & RowDataPacket)[]>(
          "SELECT * FROM users WHERE id = ?",
          [userId]
        )
        .catch(throwErrorWith("failed to get user"));

      if (!user) {
        await conn.rollback();
        return c.text("not found user that has the userid in session", 404);
      }

      const response = await fillUserResponse(
        conn,
        user,
        c.get("runtime").fallbackUserIcon
      ).catch(throwErrorWith("failed to fill user"));

      await conn.commit().catch(throwErrorWith("failed to commit"));

      return c.json(response);
    } catch (error) {
      await conn.rollback();
      return c.text(`Internal Server Error\n${error}`, 500);
    } finally {
      await conn.rollback();
      conn.release();
    }
  },
];

// ユーザ登録API
// POST /api/register
export const registerHandler = async (
  c: Context<HonoEnvironment, "/api/register">
) => {
  const body = await c.req.json<{
    name: string;
    display_name: string;
    description: string;
    password: string;
    theme: { dark_mode: boolean };
  }>();

  if (body.name === "pipe") {
    return c.text("the username 'pipe' is reserved", 400);
  }

  const hashedPassword = await c
    .get("runtime")
    .hashPassword(body.password)
    .catch(throwErrorWith("failed to generate hashed password"));

  const conn = await c.get("pool").getConnection();
  await conn.beginTransaction();

  try {
    const [{ insertId: userId }] = await conn
      .execute<ResultSetHeader>(
        "INSERT INTO users (name, display_name, description, password, dark_mode) VALUES(?, ?, ?, ?, ?)",
        [
          body.name,
          body.display_name,
          body.description,
          hashedPassword,
          body.theme.dark_mode,
        ]
      )
      .catch(throwErrorWith("failed to insert user"));

    await c
      .get("runtime")
      .exec([
        "pdnsutil",
        "add-record",
        "u.isucon.dev",
        body.name,
        "A",
        "0",
        c.get("runtime").powerDNSSubdomainAddress,
      ])
      .catch(throwErrorWith("failed to add record to powerdns"));

    const response = await fillUserResponse(
      conn,
      {
        id: userId,
        name: body.name,
        display_name: body.display_name,
        description: body.description,
        dark_mode: body.theme.dark_mode,
      },
      c.get("runtime").fallbackUserIcon
    ).catch(throwErrorWith("failed to fill user"));

    await conn.commit().catch(throwErrorWith("failed to commit"));

    return c.json(response, 201);
  } catch (error) {
    await conn.rollback();
    return c.text(`Internal Server Error\n${error}`, 500);
  } finally {
    await conn.rollback();
    conn.release();
  }
};

// ユーザログインAPI
// POST /api/login
export const loginHandler = async (
  c: Context<HonoEnvironment, "/api/login">
) => {
  const body = await c.req.json<{
    username: string;
    password: string;
  }>();

  const conn = await c.get("pool").getConnection();
  await conn.beginTransaction();

  try {
    // usernameはUNIQUEなので、whereで一意に特定できる
    const [[user]] = await conn
      .query<(UserModel & RowDataPacket)[]>(
        "SELECT * FROM users WHERE name = ?",
        [body.username]
      )
      .catch(throwErrorWith("failed to get user"));

    if (!user) {
      await conn.rollback();
      return c.text("invalid username or password", 401);
    }

    await conn.commit().catch(throwErrorWith("failed to commit"));

    const isPasswordMatch = await c
      .get("runtime")
      .comparePassword(body.password, user.password)
      .catch(throwErrorWith("failed to compare hash and password"));
    if (!isPasswordMatch) {
      return c.text("invalid username or password", 401);
    }

    // 1時間でセッションが切れるようにする
    const sessionEndAt = Date.now() + 1000 * 60 * 60;

    const session = c.get("session");
    session.set(defaultUserIDKey, user.id);
    session.set(defaultUserNameKey, user.name);
    session.set(defaultSessionExpiresKey, sessionEndAt);

    // eslint-disable-next-line unicorn/no-null
    return c.body(null);
  } catch (error) {
    await conn.rollback();
    return c.text(`Internal Server Error\n${error}`, 500);
  } finally {
    await conn.rollback();
    conn.release();
  }
};

// GET /api/user/:username
export const getUserHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, "/api/user/:username">) => {
    const username = c.req.param("username");

    const conn = await c.get("pool").getConnection();
    await conn.beginTransaction();

    try {
      const [[user]] = await conn
        .query<(UserModel & RowDataPacket)[]>(
          "SELECT * FROM users WHERE name = ?",
          [username]
        )
        .catch(throwErrorWith("failed to get user"));

      if (!user) {
        await conn.rollback();
        return c.text("not found user that has the given username", 404);
      }

      const response = await fillUserResponse(
        conn,
        user,
        c.get("runtime").fallbackUserIcon
      ).catch(throwErrorWith("failed to fill user"));

      await conn.commit().catch(throwErrorWith("failed to commit"));

      return c.json(response);
    } catch (error) {
      await conn.rollback();
      return c.text(`Internal Server Error\n${error}`, 500);
    } finally {
      await conn.rollback();
      conn.release();
    }
  },
];
