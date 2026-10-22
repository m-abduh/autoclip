import axios from "axios";

const API_URL = process.env.BUFFER_API_URL || "https://api.buffer.com";
const MODE = process.env.BUFFER_MODE || "shareNow"; // shareNow | addToQueue | customScheduled

function resolveToken(token) {
  const t = token || process.env.BUFFER_API_KEY || process.env.BUFFER_TOKEN;
  if (!t) throw new Error("API key Buffer belum diisi (tambahkan akun Buffer di kampanye)");
  return t;
}

async function graphql(query, variables = {}, token) {
  const res = await axios.post(
    API_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolveToken(token)}`,
      },
      validateStatus: () => true,
    }
  );
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`Buffer API error ${res.status}: ${body}`);
  }
  if (res.data?.errors?.length) {
    throw new Error(
      `Buffer GraphQL error: ${res.data.errors.map((e) => e.message).join("; ")}`
    );
  }
  return res.data?.data;
}

// Semua channel dari semua organization yang bisa diakses token ini.
export async function getChannels(token) {
  const orgData = await graphql(`query { account { organizations { id } } }`, {}, token);
  const orgs = orgData?.account?.organizations ?? [];
  if (!orgs.length) return { organizations: [], channels: [] };

  const channels = [];
  const seen = new Set();
  for (const org of orgs) {
    const chData = await graphql(
      `query ($orgId: OrganizationId!) {
        channels(input: { organizationId: $orgId }) { id name service }
      }`,
      { orgId: org.id },
      token
    );
    for (const ch of chData?.channels ?? []) {
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      channels.push({ ...ch, organizationId: org.id });
    }
  }
  return { organizations: orgs, channels };
}

export async function testToken(token) {
  const { organizations, channels } = await getChannels(token);
  return { organizations: organizations.length, channels: channels.length };
}

function buildMetadata(service, videoTitle) {
  switch (service) {
    case "instagram":
      return { instagram: { type: "post", shouldShareToFeed: true } };
    case "youtube":
      return {
        youtube: {
          title: videoTitle || "AutoClip",
          privacy: process.env.YOUTUBE_PRIVACY || "public",
          categoryId: process.env.YOUTUBE_CATEGORY_ID || "24",
        },
      };
    default:
      return null; // tiktok & lainnya: pakai default Buffer
  }
}

export async function createPost({
  token,
  channelId,
  service,
  text,
  videoUrl,
  videoTitle,
  thumbnailOffset,
}) {
  const videoAsset = { url: videoUrl };
  if (thumbnailOffset != null) videoAsset.metadata = { thumbnailOffset };

  const input = {
    text,
    channelId,
    schedulingType: "automatic",
    mode: MODE,
    assets: videoUrl ? [{ video: videoAsset }] : [],
  };

  const metadata = buildMetadata(service, videoTitle);
  if (metadata) input.metadata = metadata;

  const query = `mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id text dueAt } }
      ... on MutationError { message }
    }
  }`;

  const data = await graphql(query, { input }, token);
  const result = data?.createPost;
  if (result?.post) return { postId: result.post.id, dueAt: result.post.dueAt };
  throw new Error(result?.message || "Buffer menolak createPost (tanpa pesan)");
}
