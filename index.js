import axios from "axios";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import dotenv from "dotenv";
import path from "path";
import OpenAI from "openai";
import * as PlayHT from "playht";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import { exec } from "child_process";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
PlayHT.init({
  userId: process.env.PLAYHT_USER_ID,
  apiKey: process.env.PLAYHT_API_KEY,
});

const subreddits = [
  { name: "AmItheAsshole", sort: "top.json?t=all" },
  { name: "relationshipadvice", sort: "top.json?t=all" },
  { name: "relationship_advice", sort: "top.json?t=month" },
];
const backgroundVideoPath = "./videoplayback.mp4";
const cacheFilePath = "./shortTitleCache.json";
let shortTitleCache = fs.existsSync(cacheFilePath)
  ? JSON.parse(fs.readFileSync(cacheFilePath, "utf8"))
  : {};

const saveCache = () =>
  fs.writeFileSync(cacheFilePath, JSON.stringify(shortTitleCache, null, 2));

const sanitizeTitle = (title) =>
  title
    .replace(/[^a-z0-9]/gi, "_")
    .replace(/_+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const shortenTitle = async (title) => {
  const prompt = `Shorten the following title while retaining its meaning and ensure that it is no more than 20 characters long. Return only the shortened title without any additional commentary: "${title}"`;
  console.log(`Shortening title: "${title}"`);
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: prompt }],
      text: { format: { type: "text" } },
      reasoning: {},
      tools: [],
      temperature: 1,
      max_output_tokens: 2048,
      top_p: 1,
      store: true,
    });
    console.log(`Title shortened to: "${response.output_text}"`);
    return response.output_text;
  } catch (error) {
    console.error("Error shortening title:", error.message);
    return title;
  }
};

const getShortTitle = async (postTitle) => {
  if (shortTitleCache[postTitle]) return shortTitleCache[postTitle];
  const shortTitle = await shortenTitle(postTitle);
  shortTitleCache[postTitle] = shortTitle;
  saveCache();
  return shortTitle;
};

const fetchRedditPosts = async (subreddit, sort) => {
  const url = `https://www.reddit.com/r/${subreddit}/${sort}`;
  console.log(`Fetching posts from URL: ${url}`);
  try {
    const response = await axios.get(url);
    console.log(
      `Fetched ${response.data.data.children.length} posts from r/${subreddit}`
    );
    return response.data.data.children.map((child) => child.data);
  } catch (error) {
    console.error(`Error fetching posts from r/${subreddit}:`, error.message);
    return [];
  }
};

const correctText = async (text) => {
  const prompt = `Correct the following text for spelling and grammar without changing any of the actual words, slang, abbreviations, or shorthand. Also add periods, punctuation, and new lines where needed to make it follow normal human speech patterns. Return only the corrected text without any commentary:\n\n${text}`;
  console.log("Correcting text...");
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "user", content: [{ type: "input_text", text: prompt }] },
      ],
      text: { format: { type: "text" } },
      reasoning: {},
      tools: [],
      temperature: 1,
      max_output_tokens: 2048,
      top_p: 1,
      store: true,
    });
    console.log("Text correction complete.");
    return response.output_text;
  } catch (error) {
    console.error("Error in GPT text correction:", error.message);
    return text;
  }
};

/**
 * Generates TTS audio for a given text segment.
 * The output file name is tagged with a part index.
 */
const generateSegmentSpeech = async (
  segmentText,
  shortTitle,
  subredditFolder,
  segmentIndex = 1
) => {
  const audioFilePath = `./${subredditFolder}/${sanitizeTitle(
    shortTitle
  )}/audio/audio_${sanitizeTitle(shortTitle)}_part${segmentIndex}.mp3`;
  ensureDir(audioFilePath);
  if (fs.existsSync(audioFilePath)) {
    console.log(
      `Audio file already exists at ${audioFilePath}. Skipping speech generation.`
    );
    return audioFilePath;
  }
  console.log(
    `Generating speech for segment ${segmentIndex} of "${shortTitle}"`
  );
  try {
    const stream = await PlayHT.stream(segmentText, {
      voiceEngine: "Play3.0-mini",
      voiceId:
        "s3://voice-cloning-zero-shot/abc2d0e6-9433-4dcc-b416-0b035169f37e/original/manifest.json",
    });
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => fs.appendFileSync(audioFilePath, chunk));
      stream.on("end", () => {
        console.log(
          `Audio generation complete for segment ${segmentIndex}: ${audioFilePath}`
        );
        resolve(audioFilePath);
      });
      stream.on("error", (err) => {
        console.error("Error in streaming audio from PlayHT:", err);
        reject(err);
      });
    });
  } catch (error) {
    console.error("Error generating speech from PlayHT:", error.message);
    return null;
  }
};

/**
 * Generates a screenshot image.
 * If customContent is provided, it is used as the post's content.
 * The screenshot file name is made unique per segment if segmentIndex is provided.
 * The SVG icons remain intact.
 */
const generateScreenshot = async (
  post,
  shortTitle,
  subredditFolder,
  customContent = null,
  segmentIndex = null
) => {
  console.log(`Generating screenshot for post: "${post.title}"`);
  const sub = post.subreddit_name_prefixed || "unknown";
  const author = post.author || "unknown";
  const title = post.title;
  // Use customContent if provided, otherwise correct full selftext.
  const content =
    customContent || (await correctText(post.selftext)) || "[No text content]";
  const htmlContent = `
<html>
  <head>
    <style>
      html, body { margin: 0; padding: 0; background: transparent; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; }
      .container { max-width: 600px; margin: auto; background-color: #121212; border: 1px solid #080808; border-radius: 20px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); padding: 20px; display: flex; flex-direction: column; gap: 10px; align-items: left; }
      .sub { font-size: 30px; font-weight: bold; color: #C2C2C2; }
      .author { font-size: 14px; color: #C2C2C2; }
      .title { font-size: 20px; font-weight: bold; color: #F3F3F3; }
      .content { font-size: 16px; line-height: 1.5; color: #A6A6A6; margin-bottom: 10px; }
      .bottomInfo { display: flex; flex-direction: row; gap: 20px; }
      .ups, .comments { font-size: 14px; display: flex; flex-direction: row; align-items: center; gap: 5px; }
      .ups { color: #D93900; }
      .comments { color: #f3f3f3; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="sub">${sub}</div>
      <div class="author">u/${author}</div>
      <div class="title">${title}</div>
      <div class="content">${content}</div>
      <div class="bottomInfo">
        <div class="ups">
          <svg rpl="" fill="#D93900" height="16" icon-name="upvote-fill" viewBox="0 0 20 20" width="16" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 19c-.072 0-.145 0-.218-.006A4.1 4.1 0 0 1 6 14.816V11H2.862a1.751 1.751 0 0 1-1.234-2.993L9.41.28a.836.836 0 0 1 1.18 0l7.782 7.727A1.751 1.751 0 0 1 17.139 11H14v3.882a4.134 4.134 0 0 1-.854 2.592A3.99 3.99 0 0 1 10 19Z"></path>
          </svg>
          ${post.ups}
        </div>
        <div class="comments">
          <svg rpl="" aria-hidden="true" class="icon-comment" fill="currentColor" height="16" icon-name="comment-outline" viewBox="0 0 20 20" width="16" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 19H1.871a.886.886 0 0 1-.798-.52.886.886 0 0 1 .158-.941L3.1 15.771A9 9 0 1 1 10 19Zm-6.549-1.5H10a7.5 7.5 0 1 0-5.323-2.219l.54.545L3.451 17.5Z"></path>
          </svg>
          ${post.num_comments}
        </div>
      </div>
    </div>
  </body>
</html>`;
  let screenshotFileName = `screenshot_${sanitizeTitle(shortTitle)}`;
  if (segmentIndex !== null) {
    screenshotFileName += `_part${segmentIndex}`;
  }
  screenshotFileName += `.png`;
  const screenshotPath = `./${subredditFolder}/${sanitizeTitle(
    shortTitle
  )}/screenshot/${screenshotFileName}`;
  if (fs.existsSync(screenshotPath)) {
    console.log(
      `Screenshot already exists at ${screenshotPath}. Skipping screenshot generation.`
    );
    return screenshotPath;
  }
  ensureDir(screenshotPath);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 400 });
  await page.setContent(htmlContent, { waitUntil: "networkidle0" });
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    omitBackground: true,
  });
  await browser.close();
  console.log(`Screenshot generated at ${screenshotPath}`);
  return screenshotPath;
};

const generateDescription = async (
  title,
  postText,
  subredditFolder,
  shortTitle
) => {
  console.log(`Generating YouTube video description for: "${title}"`);
  const prompt = `Based on the following title and post text, generate a concise and engaging description for a YouTube video. Return only the description text without any commentary.\n\nTitle: "${title}"\n\nPost Text: "${postText}"`;
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: prompt }],
      text: { format: { type: "text" } },
      reasoning: {},
      tools: [],
      temperature: 1,
      max_output_tokens: 200,
      top_p: 1,
      store: true,
    });
    const description = response.output_text;
    const descriptionPath = `./${subredditFolder}/${sanitizeTitle(
      shortTitle
    )}/description/description.txt`;
    ensureDir(descriptionPath);
    fs.writeFileSync(descriptionPath, description);
    console.log(`Description generated and saved at ${descriptionPath}`);
    return description;
  } catch (error) {
    console.error("Error generating description:", error.message);
    return "";
  }
};

const getAudioDuration = (filePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });

const createVideo = async (
  backgroundPath,
  audioPath,
  screenshotPath,
  outputPath
) => {
  console.log(`Creating video at ${outputPath}`);
  const audioDuration = await getAudioDuration(audioPath);
  const bgStart = "00:00:05";
  ensureDir(outputPath);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(backgroundPath)
      .inputOptions([`-ss ${bgStart}`])
      .input(screenshotPath)
      .input(audioPath)
      .complexFilter([
        {
          filter: "scale",
          options: { w: -2, h: 1920 },
          inputs: "0:v",
          outputs: "bgScaled",
        },
        {
          filter: "crop",
          options: { w: 1080, h: 1920, x: "(in_w-1080)/2", y: "0" },
          inputs: "bgScaled",
          outputs: "bg",
        },
        {
          filter: "scale",
          options: { w: 900, h: -1 },
          inputs: "1:v",
          outputs: "ssScaled",
        },
        {
          filter: "colorchannelmixer",
          options: { aa: 0.9 },
          inputs: "ssScaled",
          outputs: "ss",
        },
        {
          filter: "overlay",
          options: { x: "(W-w)/2", y: "(H-h)/2" },
          inputs: ["bg", "ss"],
          outputs: "v",
        },
      ])
      .outputOptions([
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-t",
        audioDuration.toString(),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
      ])
      .save(outputPath)
      .on("end", () => {
        console.log(`Video creation completed: ${outputPath}`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error("Error creating video:", err.message);
        reject(err);
      });
  });
};

const splitVideo = async (inputPath, segmentDuration = 60) =>
  new Promise((resolve, reject) => {
    console.log(
      `Splitting video: ${inputPath} into segments of ${segmentDuration} seconds`
    );
    ffmpeg(inputPath)
      .outputOptions([
        "-c",
        "copy",
        "-map",
        "0",
        "-segment_time",
        segmentDuration.toString(),
        "-f",
        "segment",
        "-reset_timestamps",
        "1",
      ])
      .output("segment_%d.mp4")
      .on("end", async () => {
        let segments = fs
          .readdirSync(".")
          .filter(
            (file) => file.startsWith("segment_") && file.endsWith(".mp4")
          );
        // Sort segments by numerical order
        segments.sort((a, b) => {
          const aNum = parseInt(a.match(/segment_(\d+)\.mp4/)[1]);
          const bNum = parseInt(b.match(/segment_(\d+)\.mp4/)[1]);
          return aNum - bNum;
        });
        console.log(`Video split into ${segments.length} segments.`);

        // Check if the last segment is less than 30 seconds and merge if needed.
        if (segments.length > 1) {
          const lastSegment = segments[segments.length - 1];
          let lastDuration = 0;
          try {
            lastDuration = await getAudioDuration(lastSegment);
          } catch (err) {
            console.error(
              "Error getting duration of last segment:",
              err.message
            );
          }
          if (lastDuration < 30) {
            console.log(
              `Last segment "${lastSegment}" is only ${lastDuration} seconds long. Merging it with the previous segment.`
            );
            const prevSegment = segments[segments.length - 2];
            const concatList = `file '${prevSegment}'\nfile '${lastSegment}'\n`;
            fs.writeFileSync("concat_list.txt", concatList);
            try {
              await new Promise((resolveMerge, rejectMerge) => {
                exec(
                  "ffmpeg -f concat -safe 0 -i concat_list.txt -c copy merged_last.mp4",
                  (err) => {
                    if (err) return rejectMerge(err);
                    resolveMerge();
                  }
                );
              });
              // Remove old segments and replace the previous segment with the merged file
              fs.unlinkSync(prevSegment);
              fs.unlinkSync(lastSegment);
              fs.renameSync("merged_last.mp4", prevSegment);
              fs.unlinkSync("concat_list.txt");
              // Remove the last segment from the segments array
              segments.pop();
              console.log(
                `Merged segments into "${prevSegment}". Total segments now: ${segments.length}`
              );
            } catch (mergeError) {
              console.error("Error merging last segments:", mergeError.message);
            }
          }
        }
        resolve(segments);
      })
      .on("error", (err) => {
        console.error("Error splitting video:", err.message);
        reject(err);
      })
      .run();
  });

const uploadToYouTube = async (videoPath, title) => {
  console.log(`Uploading video to YouTube: ${videoPath}`);
  try {
    const vidsFolder = path.dirname(videoPath);
    const baseFolder = path.dirname(vidsFolder);
    const descriptionFilePath = path.join(
      baseFolder,
      "description",
      "description.txt"
    );
    let description = "";
    if (fs.existsSync(descriptionFilePath)) {
      description = fs.readFileSync(descriptionFilePath, "utf8");
    } else {
      console.warn(
        `Description file not found at ${descriptionFilePath}. Using an empty description.`
      );
    }
    const oauth2Client = new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      process.env.YOUTUBE_REDIRECT_URI || "http://localhost"
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
    });
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const response = await youtube.videos.insert({
      part: "snippet,status",
      requestBody: {
        snippet: { title, description, categoryId: "22" },
        status: { privacyStatus: "public" },
      },
      media: { body: fs.createReadStream(videoPath) },
    });
    console.log(
      `Successfully uploaded video. YouTube video ID: ${response.data.id}`
    );
    return response.data;
  } catch (error) {
    console.error("Error uploading video to YouTube:", error.message);
    throw error;
  }
};

const uploadAllVideos = async (vidsFolderPath, subredditFolder, title) => {
  if (!fs.existsSync(vidsFolderPath)) {
    console.warn(`Vids folder not found at ${vidsFolderPath}`);
    return;
  }
  const videoFiles = fs
    .readdirSync(vidsFolderPath)
    .filter((file) => file.endsWith(".mp4"));
  for (const videoFile of videoFiles) {
    const videoPath = path.join(vidsFolderPath, videoFile);
    const videoTitle = `r/${subredditFolder} - ${title} - Part ${path
      .parse(videoFile)
      .name.replace(/.*part/, "")
      .replace(/_/g, "")}`;
    console.log(`Uploading video: ${videoPath} with title: ${videoTitle}`);
    try {
      await uploadToYouTube(videoPath, videoTitle);
    } catch (error) {
      console.error(`Failed to upload ${videoPath}:`, error.message);
    }
  }
};

/**
 * Splits text into segments of at least minWords words.
 * This helps ensure that longer posts are divided into multiple segments.
 */
const splitTextIntoSegments = (text, minWords = 75) => {
  const words = text.split(/\s+/);
  const segments = [];
  let currentSegment = [];

  words.forEach((word) => {
    currentSegment.push(word);
    if (currentSegment.length >= minWords) {
      // Optionally split on sentence boundaries if the word ends with punctuation.
      if (/[.!?]$/.test(word)) {
        segments.push(currentSegment.join(" "));
        currentSegment = [];
      }
    }
  });
  // Add any remaining words. If too short, merge with previous segment.
  if (currentSegment.length) {
    if (segments.length && currentSegment.length < minWords) {
      segments[segments.length - 1] += " " + currentSegment.join(" ");
    } else {
      segments.push(currentSegment.join(" "));
    }
  }
  return segments;
};

/**
 * Process a single Reddit post:
 * - Correct the text,
 * - Split it into segments if the post exceeds 300 words,
 * - Generate assets (audio, screenshot) for each segment,
 * - Create a video for each segment,
 * - And upload the resulting videos.
 */
const processPost = async (post, subredditFolder) => {
  const postTitle = post.title;
  const postContent = post.selftext || "";

  // Skip posts with the word "update" in the title or post text
  if (
    postTitle.toLowerCase().includes("update") ||
    postContent.toLowerCase().includes("update")
  ) {
    console.log(`Skipping post "${postTitle}" due to presence of "update".`);
    return;
  }
  // Skip posts with more than 600 words in the post text
  if (postContent.split(" ").length > 600) {
    console.log(
      `Skipping post "${postTitle}" due to word count exceeding 600.`
    );
    return;
  }

  console.log(`Processing post: "${postTitle}"`);
  const combinedText = `${postTitle}\n\n${postContent}`;
  const correctedText = await correctText(combinedText);
  const shortTitle = await getShortTitle(postTitle);

  // Determine if we need to split the text into segments.
  const totalWords = correctedText.split(/\s+/).length;
  let segments = [];
  if (totalWords > 400) {
    segments = splitTextIntoSegments(correctedText, 150);
    console.log(
      `Post has ${totalWords} words; split into ${segments.length} segments.`
    );
  } else {
    segments = [correctedText];
  }

  // Generate a description for the full post.
  await generateDescription(
    postTitle,
    postContent,
    subredditFolder,
    shortTitle
  );

  // Process each segment separately.
  for (let i = 0; i < segments.length; i++) {
    const segmentText = segments[i];
    const segmentIndex = i + 1;

    // Generate TTS audio for the segment.
    const audioPath = await generateSegmentSpeech(
      segmentText,
      shortTitle,
      subredditFolder,
      segmentIndex
    );
    if (!audioPath) {
      console.error("Skipping segment due to audio generation failure.");
      continue;
    }
    // Generate a screenshot for the segment (using the segment's text).
    const screenshotPath = await generateScreenshot(
      post,
      shortTitle,
      subredditFolder,
      segmentText,
      segmentIndex
    );

    // Generate a video for this segment.
    const outputVideoPath = `./${subredditFolder}/${sanitizeTitle(
      shortTitle
    )}/ogVid/video_${sanitizeTitle(shortTitle)}_part${segmentIndex}.mp4`;
    if (!fs.existsSync(outputVideoPath)) {
      ensureDir(outputVideoPath);
      try {
        await createVideo(
          backgroundVideoPath,
          audioPath,
          screenshotPath,
          outputVideoPath
        );
      } catch (error) {
        console.error("Error creating video segment:", error.message);
        continue;
      }
    } else {
      console.log(
        `Video segment already exists at ${outputVideoPath}. Skipping creation.`
      );
    }

    // Optionally, upload each segment immediately.
    try {
      await uploadToYouTube(
        outputVideoPath,
        `${shortTitle} ${
          segments.length > 1 ? `- Part ${segmentIndex}` : ""
        } #relationshipadvice #shorts #trending #viral`
      );
    } catch (error) {
      console.error(
        `Failed to upload video segment ${segmentIndex}:`,
        error.message
      );
    }
  }
};

const processSubreddits = async () => {
  for (const { name: subredditFolder, sort } of subreddits) {
    console.log(`Processing subreddit: r/${subredditFolder}`);
    const posts = await fetchRedditPosts(subredditFolder, sort);
    for (const post of posts) {
      await processPost(post, subredditFolder);
    }
  }
};

processSubreddits();
