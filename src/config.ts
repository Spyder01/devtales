export const SITE = {
  website: "https://devtales.suhan.art", // replace this with your deployed domain
  author: "Suhan Bangera",
  profile: "https://devtales.suhan.art",
  desc: "A dev blog about low-level systems, compilers, runtimes, and the stuff that runs underneath.",
  title: "DevTales",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 5,
  postPerPage: 5,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/spyder01/devtales/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr", // "rtl" | "auto"
  lang: "en", // html lang code. Set this empty and default will be "en"
  timezone: "Asia/Kolkata", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
