# Instagram Scraper

Instagram Scraper allows you to scrape public data from Instagram profile pages, reels, and posts. Provide one or more Instagram URLs and the scraper will extract structured JSON, and a readable Markdown summary where applicable.

This unofficial scraper restores access to public data that was removed from the official Instagram API in 2020. It does not access private data and is intended for ethical, compliant use cases only.

## What you can scrape

- **Profiles**: basic profile metadata via `web_profile_info` (pre-navigation capture)
- **Reels**: detection for reel URLs with future expansion for reel metadata
- **Posts**: post pages and media are recognized (future expansion)
- **Comments**: designed to support post comments extraction (future expansion)

## Supported URL formats

- Profile: `https://www.instagram.com/<username>/`
- Reel: `https://www.instagram.com/reel/<shortcode>/`
- Hashtag: `https://www.instagram.com/explore/tags/<tag>/` (roadmap)
- Place: `https://www.instagram.com/explore/locations/<id>/<slug>/` (roadmap)

## Input parameters

These variables control scraper behavior. They map to Playwright request options in the template.

- **waitFor (ms)**: Delay before extraction begins. Default: `500`. Mapped to `wait_for`.
- **timeoutMs (ms)**: Overrides the request timeout. Default: `35000`. Mapped to `timeout`.

Example input JSON:

```json
{
  "url": "https://www.instagram.com/instagram/",
  "waitFor": 700,
  "timeoutMs": 35000
}
```

You can also run multiple URLs in a batch—each URL will produce its own result item.

## Output

- Field: `jsonResult` — an array of extracted items per URL
- Field: `markdown` — a human-readable summary where available

Example output (profile URL, illustrative):

```json
[
  {
    "reel_id": "DP4DbBmEXv3",
    "full_text": "",
    "video": "https://scontent-lax3-1.cdninstagram.com/o1/v/t2/f2/m86/AQPrHW7lDS_9yOlpw60rtqOBNCiaOKkdYuUinrsVjhBNUFpvAhg8gLrg5pP-ueJRVYj19QQTWQsqN_UH8cQh029mp2Xfp44ifObnj_U.mp4?_nc_cat=109&_nc_sid=5e9851&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_ohc=I5jTV1wSqjEQ7kNvwHMAU3Z&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0xJUFMuQzMuNzIwLmRhc2hfYmFzZWxpbmVfMV92MSIsInhwdl9hc3NldF9pZCI6MTUyNzMwMDgwNDk1ODUwNSwidmlfdXNlY2FzZV9pZCI6MTAwOTksImR1cmF0aW9uX3MiOjU0LCJ1cmxnZW5fc291cmNlIjoid3d3In0%3D&ccb=17-1&vs=c4136c8cbfde5b7d&_nc_vs=HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZC82RTRGOTMwQUY5MTI1MTc2NEJGMTY3ODhGNjU0NTBBQ192aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYOnBhc3N0aHJvdWdoX2V2ZXJzdG9yZS9HSkM4bGlIUWplNnBnUXdFQUtDVFl0V0ROcGdIYnN0VEFRQUYVAgLIARIAKAAYABsCiAd1c2Vfb2lsATEScHJvZ3Jlc3NpdmVfcmVjaXBlATEVAAAm0uSO383EtgUVAigCQzMsF0BLJmZmZmZmGBJkYXNoX2Jhc2VsaW5lXzFfdjERAHX-B2XmnQEA&_nc_gid=oOaJHQ1Tj-GsDfLv97Kqfg&_nc_zt=28&oh=00_Aff_jIdpgD_Fvj1EhtnhCLp_pWZcm0gRICle0Z5drq9Nwg&oe=68FAF74E",
    "image": "https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/564449113_18673826536001321_8685025130070580900_n.jpg?stp=c0.420.1080.1080a_dst-jpg_e35_s640x640_sh0.08_tt6&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHlGrosvsgbYo-GphgkUTdeBLlFH3-zZJ6RuBWW4wsKq_jtv3THRrvG653Qx32KYUQ&_nc_ohc=uZbPQK4L0wEQ7kNvwF5hjw-&_nc_gid=oOaJHQ1Tj-GsDfLv97Kqfg&edm=AOQ1c0wBAAAA&ccb=7-5&oh=00_AffwkAeu21YVONYxpWy15lU3XoZPc0QHbZgcYu--EtWLTw&oe=68FF0B90&_nc_sid=8b3546",
    "token_at": 1760630598,
    "token_at_utc": "2025-10-16T16:03:18.000Z",
    "user": {
      "full_name": "Instagram",
      "profile_pic_url": "https://scontent-lax3-1.cdninstagram.com/v/t51.2885-19/550891366_18667771684001321_1383210656577177067_n.jpg?stp=dst-jpg_s320x320_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMyIn0&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHlGrosvsgbYo-GphgkUTdeBLlFH3-zZJ6RuBWW4wsKq_jtv3THRrvG653Qx32KYUQ&_nc_ohc=ZkVzcUc41-8Q7kNvwG-QiVk&_nc_gid=oOaJHQ1Tj-GsDfLv97Kqfg&edm=AOQ1c0wBAAAA&ccb=7-5&oh=00_AfcFE4VfyM6Sif2bRPllTGVJ8LfpxftwWyKRRYv8kfiCMg&oe=68FEDF71&_nc_sid=8b3546",
      "is_private": false,
      "is_embeds_disabled": false,
      "is_unpublished": null,
      "is_verified": true,
      "friendship_status": null,
      "latest_reel_media": null,
      "biography": "Discover what's new on Instagram 🔎✨",
      "business_email": null,
      "business_phone_number": null,
      "business_address_json": null,
      "is_business_account": false,
      "posted_count": 8197,
      "followers_count": 695734310,
      "follow_count": 263
    },
    "comments": [],
    "usertags": [
      {
        "user": {
          "full_name": "Sofia Santino",
          "username": "sofiasantino",
          "profile_pic_url": "https://scontent-lax3-1.cdninstagram.com/v/t51.2885-19/481877878_1837804263632840_2577011412828617515_n.jpg?stp=dst-jpg_s150x150_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMyIn0&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHlGrosvsgbYo-GphgkUTdeBLlFH3-zZJ6RuBWW4wsKq_jtv3THRrvG653Qx32KYUQ&_nc_ohc=cl_PauZxAAwQ7kNvwF-u8HW&_nc_gid=oOaJHQ1Tj-GsDfLv97Kqfg&edm=AOQ1c0wBAAAA&ccb=7-5&oh=00_Afen9ebDezBdI4t-F8isaqD0qcyi3L-E0WrbLAuaSv4ClQ&oe=68FEF308&_nc_sid=8b3546",
          "is_verified": true,
          "id": "289410285"
        }
      }
    ],
    "location": null,
    "has_audio": true,
    "has_liked": true,
    "display_uri": "https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/564449113_18673826536001321_8685025130070580900_n.jpg?stp=dst-jpg_e15_fr_p1080x1080_tt6&_nc_ht=scontent-lax3-1.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHlGrosvsgbYo-GphgkUTdeBLlFH3-zZJ6RuBWW4wsKq_jtv3THRrvG653Qx32KYUQ&_nc_ohc=uZbPQK4L0wEQ7kNvwF5hjw-&_nc_gid=oOaJHQ1Tj-GsDfLv97Kqfg&edm=AOQ1c0wBAAAA&ccb=7-5&oh=00_AffS84J76icxIIxUjDltEt8uzrGDjVZH0hKb7EymWqnZSA&oe=68FF0B90&_nc_sid=8b3546",
    "video_view_count": 8797990,
    "like_count": 322012,
    "comment_count": 4298,
    "create_at": "2025-10-16T16:03:18.000Z",
    "fb_comment_count": null,
    "is_paid_partnership": null,
    "sponsor_tags": null,
    "original_height": 1920,
    "original_width": 1080,
    "is_video": true
  },
  ...
]
```

```json
[
  {
    "reel_id": "DQHeYsSDKcP",
    "full_text": "this is what we mean when we send 🤹\n\n#InTheMoment\n\nVideo by @wadestokan \nMusic by @theb52sband",
    "video": "https://scontent.cdninstagram.com/o1/v/t2/f2/m86/AQMxfesN9GKtXtPpGfZq9N07zB9Hb0NKf-18Wo-tHFTSQEWlq4A26TzlIqDBEPvdUtGV89lreuG3d8ON7g0T5zh38XUolYZASyXE64A.mp4?_nc_cat=1&_nc_sid=5e9851&_nc_ht=scontent.cdninstagram.com&_nc_ohc=OnMSD2M8PewQ7kNvwFRRRZW&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5JTlNUQUdSQU0uQ0xJUFMuQzMuNzIwLmRhc2hfYmFzZWxpbmVfMV92MSIsInhwdl9hc3NldF9pZCI6NDI5NTg3MjkwMDczOTg2MCwidmlfdXNlY2FzZV9pZCI6MTAwOTksImR1cmF0aW9uX3MiOjE1LCJ1cmxnZW5fc291cmNlIjoid3d3In0%3D&ccb=17-1&vs=1c1ca3eb0118cd5a&_nc_vs=HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZC82RTQzNzk4NzI0NzkzMTVFMkNGQjdBQTAwQzk2NTM4Q192aWRlb19kYXNoaW5pdC5tcDQVAALIARIAFQIYOnBhc3N0aHJvdWdoX2V2ZXJzdG9yZS9HRHZORXlFWUsyaGxpbUFGQUFMc28wbG9yZmtCYnN0VEFRQUYVAgLIARIAKAAYABsCiAd1c2Vfb2lsATEScHJvZ3Jlc3NpdmVfcmVjaXBlATEVAAAmqMz9o9vEoQ8VAigCQzMsF0AuAAAAAAAAGBJkYXNoX2Jhc2VsaW5lXzFfdjERAHX-B2XmnQEA&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&_nc_zt=28&oh=00_AffmJEeBmhmyMFbg3S2sOM4R4MIo6UXAGZy9P1kcUjJTGg&oe=68FB0B09",
    "imaage": "https://scontent.cdninstagram.com/v/t51.82787-15/568441371_18675425119001321_4389840255241913418_n.jpg?stp=dst-jpg_e15_tt6&_nc_cat=1&ig_cache_key=Mzc0OTA5ODg1MzAxOTQ2MTM5MTE4Njc1NDI1MTEzMDAxMzIx.3-ccb1-7&ccb=1-7&_nc_sid=58cdad&efg=eyJ2ZW5jb2RlX3RhZyI6InhwaWRzLjEwODB4MTkyMC5zZHIuQzMifQ%3D%3D&_nc_ohc=z8W1CE6LfUgQ7kNvwElsNBT&_nc_oc=Adm5WK2ZVL8VdYin7N2wb5m-8uLq9TjHWVoN7jgj8RCPJxQcuIf2GILUqJ7CsEiI4PU&_nc_ad=z-m&_nc_cid=0&_nc_zt=23&_nc_ht=scontent.cdninstagram.com&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&oh=00_AfcwEKbPMETpsE6pIxA1N7n333O_HEHsWJFrz0Ho0RwqHQ&oe=68FEFB7F",
    "token_at": 1761149012,
    "user": {
      "full_name": "Instagram",
      "profile_pic_url": "https://scontent.cdninstagram.com/v/t51.2885-19/550891366_18667771684001321_1383210656577177067_n.jpg?stp=dst-jpg_s150x150_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMxIn0&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHtoeYByYJkqGg-5laFPa3Eok6l0kI7PQsujuCf-qqsQgQstqtPBLb1DQK2R31xiw0&_nc_ohc=ZkVzcUc41-8Q7kNvwEK_pvW&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_AffComiK37abEsbyGoL6Rtd4nwiy0qstRq4FcoHz96qvzA&oe=68FEDF71&_nc_sid=10d13b",
      "is_private": false,
      "is_embeds_disabled": false,
      "is_unpublished": false,
      "is_verified": true,
      "friendship_status": null,
      "latest_reel_media": null,
      "picture_url": "https://scontent.cdninstagram.com/v/t51.2885-19/550891366_18667771684001321_1383210656577177067_n.jpg?efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMxIn0&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHtoeYByYJkqGg-5laFPa3Eok6l0kI7PQsujuCf-qqsQgQstqtPBLb1DQK2R31xiw0&_nc_ohc=ZkVzcUc41-8Q7kNvwEK_pvW&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_AfdC4-VToYKfMgvlJlMmnZyzrJo9ajBSHbr89J1ZZwl2ZQ&oe=68FEDF71&_nc_sid=10d13b"
    },
    "owner": {
      "username": "instagram",
      "profile_pic_url": "https://scontent.cdninstagram.com/v/t51.2885-19/550891366_18667771684001321_1383210656577177067_n.jpg?stp=dst-jpg_s150x150_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMxIn0&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHtoeYByYJkqGg-5laFPa3Eok6l0kI7PQsujuCf-qqsQgQstqtPBLb1DQK2R31xiw0&_nc_ohc=ZkVzcUc41-8Q7kNvwEK_pvW&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_AffComiK37abEsbyGoL6Rtd4nwiy0qstRq4FcoHz96qvzA&oe=68FEDF71&_nc_sid=10d13b",
      "is_verified": true,
      "id": "25025320",
      "friendship_status": null
    },
    "comments": [
      {
        "comment_like_count": null,
        "parent_comment_id": null,
        "created_at": 1761150341,
        "text": "Hey that’s ME",
        "has_liked_comment": null,
        "restricted_status": null,
        "child_comment_count": 22,
        "is_covered": false,
        "user": {
          "username": "wadestokan",
          "profile_pic_url": "https://scontent.cdninstagram.com/v/t51.2885-19/481418544_607095882034162_3642659380539214755_n.jpg?stp=dst-jpg_s150x150_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMxIn0&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHPdzsxa-31Mz7ZLVd4TYP--5awTQUifAhxOae-E-lVDYSbMb_5cE8H6cO-_gBUhF8&_nc_ohc=zu9zN3Ki_4UQ7kNvwEhULqL&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_AfcmjzfA5GC_VmHKhaa8jsjA1nH1ygaqy_7PZxdtLyueZw&oe=68FEFA4F&_nc_sid=10d13b",
          "is_verified": false,
          "is_unpublished": null
        }
      },
      ...
    ],
    "usertags": [
      {
        "user": {
          "full_name": "Wade Stokan",
          "username": "wadestokan",
          "profile_pic_url": "https://scontent.cdninstagram.com/v/t51.2885-19/481418544_607095882034162_3642659380539214755_n.jpg?stp=dst-jpg_s150x150_tt6&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLmRqYW5nby4xMDgwLmMxIn0&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHtoeYByYJkqGg-5laFPa3Eok6l0kI7PQsujuCf-qqsQgQstqtPBLb1DQK2R31xiw0&_nc_ohc=zu9zN3Ki_4UQ7kNvwEhULqL&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_Afe2e0w4OokDs4DsAc828fZVWXV4Nd35SzRVAbSqOHrq4g&oe=68FEFA4F&_nc_sid=10d13b",
          "is_verified": false,
          "id": "855910237"
        }
      }
    ],
    "location": null,
    "has_audio": true,
    "media_notes": null,
    "has_liked": false,
    "display_uri": "https://scontent.cdninstagram.com/v/t51.2885-15/568441371_18675425119001321_4389840255241913418_n.jpg?stp=c0.420.1080.1080a_dst-jpg_e15_fr_s1080x1080_tt6&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_oc=Q6cZ2QHtoeYByYJkqGg-5laFPa3Eok6l0kI7PQsujuCf-qqsQgQstqtPBLb1DQK2R31xiw0&_nc_ohc=8e7mhErHMjkQ7kNvwGQX92a&_nc_gid=oDnb3hHoh-aIfur0j2ebLQ&edm=APs17CUBAAAA&ccb=7-5&oh=00_AffFl_fCD37KM2oPQnQLWUwoNwFRFJJocXrLkd2bO266zw&oe=68FED7A9&_nc_sid=10d13b",
    "like_count": 187589,
    "comment_count": 2511,
    "create_at": 1761149013,
    "fb_comment_count": null,
    "is_paid_partnership": false,
    "sponsor_tags": null,
    "original_height": 1280,
    "original_width": 720
  }
]
```

## Usage

- Paste an Instagram URL and run the template; or
- Use the API to trigger runs programmatically with the variables above.

Tips:

- For profiles, prefer direct profile URLs like `https://www.instagram.com/humansofny/`.
- If a page shows a consent wall or dynamic content, increasing `waitFor` may help.
- For bulk runs, queue multiple URLs and monitor the `jsonResult` tab after completion.

## Roadmap

- Extract profile details from instagram into normalized JSON
- Add support for posts (`/p/<shortcode>`), reels, hashtags, and places
- Add comments extraction for post detail pages
- Add pagination for profile media and latest posts
- Provide Markdown summaries for profiles/posts similar to TikTok template

## Legal and ethical use

- Only scrape public data users choose to share publicly
- Do not attempt to bypass authentication or scrape private content
- Comply with applicable laws and platform terms; consult counsel for GDPR/CCPA or other privacy regulations

## Troubleshooting

- Empty results: ensure the URL is publicly accessible in an incognito window
- Timeouts: raise `timeoutMs` and/or `waitFor`
- Consent/region banners: try running with headful mode and adjust waits or location

## Changelog

- 1.0.0 — Initial release with URL detection and pre-navigation profile capture
