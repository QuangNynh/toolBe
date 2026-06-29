const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const usernameArg = process.argv[2];
if (!usernameArg) {
  console.error('Usage: node scripts/scrape-instagram.js <username_or_url>');
  process.exit(1);
}

function getUsername(input) {
  const trimmed = input.trim();
  if (trimmed.includes('/') || trimmed.includes('instagram.com')) {
    const match = trimmed.match(/(?:instagram\.com\/)([A-Za-z0-9_.-]+)/);
    if (!match) {
      console.error('Invalid Instagram profile URL.');
      process.exit(1);
    }
    return match[1];
  }
  return trimmed;
}

const username = getUsername(usernameArg);
console.log(`Starting resilient deep scraper for Instagram channel: ${username}`);

const cacheDir = path.join(__dirname, '..', 'data', 'instagram');
fs.mkdirSync(cacheDir, { recursive: true });
const cacheFilePath = path.join(cacheDir, `${username}.json`);

function getUserFeedHeaders(user) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': '936619743392459',
    'Referer': `https://www.instagram.com/${user}/`,
    'Origin': 'https://www.instagram.com',
  };
}

async function getWebProfileInfo(user, agent) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${user}`;
  const headers = getUserFeedHeaders(user);
  
  // Try with proxy
  if (agent) {
    try {
      console.log('Fetching profile metadata using local proxy...');
      const response = await axios.get(url, { headers, httpsAgent: agent, httpAgent: agent });
      return { profile: response.data.data.user, proxyWorked: true };
    } catch (err) {
      console.warn(`Proxy profile fetch failed: ${err.message}. Retrying direct...`);
    }
  }

  // Direct fallback
  const response = await axios.get(url, { headers });
  return { profile: response.data.data.user, proxyWorked: false };
}

// Helper to make requests with retries and exponential backoff
async function requestWithRetry(options, retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios(options);
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      const backoffDelay = delayMs * Math.pow(2, attempt - 1);
      console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying in ${(backoffDelay/1000).toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

async function startScraping() {
  // Setup Proxy Agent
  const proxyUrl = 'http://localhost:8888';
  let agent = null;
  let useProxy = false;
  try {
    await axios.get('http://localhost:8888', { timeout: 1000 }).catch(() => {});
    agent = new HttpsProxyAgent(proxyUrl);
    useProxy = true;
    console.log(`Proxy server detected at ${proxyUrl}. Enabled proxy for crawling.`);
  } catch (e) {
    console.log('No local proxy running. Crawling directly (warning: may get rate-limited).');
  }

  // Load existing cache if any to support resuming
  let allRawItems = [];
  let nextMaxId = null;
  let cachedUser = null;
  let overallTotalCount = 0;
  let startPage = 1;

  if (fs.existsSync(cacheFilePath)) {
    try {
      console.log(`Cache file found. Loading existing data to resume...`);
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      const cacheData = JSON.parse(fileContent);
      
      if (cacheData && cacheData.items && cacheData.items.length > 0) {
        // Map back items to raw format for consistent formatting on finish
        allRawItems = cacheData.items.map(item => ({
          id: item.id,
          code: item.shortcode,
          media_type: item.type === 'video' ? 2 : (item.type === 'carousel' ? 8 : 1),
          caption: { text: item.title },
          video_versions: item.videoUrl ? [{ url: item.videoUrl }] : [],
          image_versions2: { candidates: [{ url: item.thumbnailUrl }] },
          like_count: item.likes,
          comment_count: item.comments,
          play_count: item.views,
          taken_at: item.takenAt
        }));

        nextMaxId = cacheData.lastMaxId || null;
        cachedUser = cacheData.user;
        overallTotalCount = cacheData.overallTotalCount || 0;
        startPage = cacheData.pagesFetched || Math.ceil(allRawItems.length / 12) + 1;
        
        console.log(`Resuming from Page ${startPage}, already collected ${allRawItems.length} items. nextMaxId: ${nextMaxId}`);
      }
    } catch (err) {
      console.warn(`Failed to read cache file to resume: ${err.message}. Starting from scratch.`);
    }
  }

  // If starting fresh or couldn't load profile info, fetch profile metadata
  if (!cachedUser) {
    let profileInfoResult;
    try {
      profileInfoResult = await getWebProfileInfo(username, useProxy ? agent : null);
    } catch (err) {
      console.error(`Failed to fetch profile info: ${err.message}`);
      process.exit(1);
    }

    // Disable proxy if it failed during metadata fetch
    if (useProxy && !profileInfoResult.proxyWorked) {
      console.log('Proxy failed profile check. Disabling proxy for subsequent calls.');
      useProxy = false;
      agent = null;
    }

    const profileInfo = profileInfoResult.profile;
    overallTotalCount = profileInfo.edge_owner_to_timeline_media?.count || 0;
    cachedUser = {
      username: profileInfo.username || username,
      fullname: profileInfo.full_name || '',
      profilePicUrl: profileInfo.profile_pic_url || '',
      id: profileInfo.pk || '',
      followersCount: profileInfo.edge_followed_by?.count || 0,
      followingCount: profileInfo.edge_follow?.count || 0,
    };
  }

  console.log(`Channel Name: ${cachedUser.fullname}`);
  console.log(`Followers: ${cachedUser.followersCount}`);
  console.log(`Total posts to fetch: ${overallTotalCount}`);

  const baseFeedUrl = `https://www.instagram.com/api/v1/feed/user/${username}/username/`;
  let hasMore = true;
  let pagesFetched = startPage - 1;
  let currentMaxId = nextMaxId;

  if (allRawItems.length > 0 && !currentMaxId) {
    hasMore = false;
    console.log('No nextMaxId cursor found. Channel dataset appears already complete.');
  }

  while (hasMore) {
    let url = baseFeedUrl;
    if (currentMaxId) {
      url += `?max_id=${currentMaxId}`;
    }

    pagesFetched++;
    console.log(`\n[Page ${pagesFetched}] Fetching from: ${url}`);
    
    let responseData = null;
    let success = false;

    // Try with proxy first (no retries on proxy if proxy is failing)
    if (useProxy && agent) {
      try {
        const response = await axios.request({
          method: 'GET',
          url,
          httpsAgent: agent,
          httpAgent: agent,
          headers: getUserFeedHeaders(username),
          timeout: 15000,
        });
        responseData = response.data;
        success = true;
      } catch (err) {
        console.warn(`Proxy request failed: ${err.message}. Disabling proxy and switching to direct...`);
        useProxy = false;
        agent = null;
      }
    }

    // Direct fallback (with retries and backoff)
    if (!success) {
      try {
        const response = await requestWithRetry({
          method: 'GET',
          url,
          headers: getUserFeedHeaders(username),
          timeout: 30000, // 30s timeout for direct requests
        }, 5, 2000);
        responseData = response.data;
        success = true;
      } catch (err) {
        console.error(`Direct page request failed after retries: ${err.message}`);
        console.log('Scraping interrupted. Saving partial data collected so far...');
        break;
      }
    }

    if (!responseData || !responseData.items || responseData.items.length === 0) {
      console.log('No more items returned by Instagram API. Done.');
      hasMore = false;
      break;
    }

    const newItemsCount = responseData.items.length;
    allRawItems = allRawItems.concat(responseData.items);
    hasMore = responseData.more_available === true;
    currentMaxId = responseData.next_max_id;

    const percentage = ((allRawItems.length / overallTotalCount) * 100).toFixed(1);
    console.log(`Fetched ${newItemsCount} items. Progress: ${allRawItems.length} / ${overallTotalCount} (${percentage}%)`);

    if (!currentMaxId) {
      hasMore = false;
    }

    // Save intermediate cache state
    saveCacheData(cachedUser, allRawItems, overallTotalCount, currentMaxId, pagesFetched);

    // Delay to respect rate limits
    if (hasMore) {
      const delay = 1000 + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.log(`\nCrawling finished. Saved file has ${allRawItems.length} items.`);
}

function saveCacheData(user, rawItems, overallTotalCount, lastMaxId, pagesFetched) {
  const formattedItems = rawItems.map((item) => {
    let type = 'image';
    if (item.media_type === 2) {
      type = 'video';
    } else if (item.media_type === 8) {
      type = 'carousel';
    }

    return {
      id: item.id,
      shortcode: item.code || item.shortcode,
      type,
      title: item.caption?.text || item.title || '',
      videoUrl: item.video_versions?.[0]?.url || item.videoUrl || null,
      thumbnailUrl: item.image_versions2?.candidates?.[0]?.url || item.thumbnailUrl || null,
      likes: item.like_count !== undefined ? item.like_count : item.likes || 0,
      comments: item.comment_count !== undefined ? item.comment_count : item.comments || 0,
      views: item.play_count !== undefined ? item.play_count : (item.views || 0),
      takenAt: item.taken_at || item.takenAt,
    };
  });

  const finalData = {
    user,
    items: formattedItems,
    overallTotalCount,
    lastMaxId,
    pagesFetched
  };

  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(finalData, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Failed to write JSON file: ${err.message}`);
  }
}

startScraping();
