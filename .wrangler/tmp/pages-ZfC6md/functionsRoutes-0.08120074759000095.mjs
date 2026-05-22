import { onRequestDelete as __api_comments_ts_onRequestDelete } from "/Users/suhanj/.projects/devtales/functions/api/comments.ts"
import { onRequestGet as __api_comments_ts_onRequestGet } from "/Users/suhanj/.projects/devtales/functions/api/comments.ts"
import { onRequestPost as __api_comments_ts_onRequestPost } from "/Users/suhanj/.projects/devtales/functions/api/comments.ts"
import { onRequestPost as __api_react_ts_onRequestPost } from "/Users/suhanj/.projects/devtales/functions/api/react.ts"
import { onRequestPost as __api_visits_ts_onRequestPost } from "/Users/suhanj/.projects/devtales/functions/api/visits.ts"

export const routes = [
    {
      routePath: "/api/comments",
      mountPath: "/api",
      method: "DELETE",
      middlewares: [],
      modules: [__api_comments_ts_onRequestDelete],
    },
  {
      routePath: "/api/comments",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_comments_ts_onRequestGet],
    },
  {
      routePath: "/api/comments",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_comments_ts_onRequestPost],
    },
  {
      routePath: "/api/react",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_react_ts_onRequestPost],
    },
  {
      routePath: "/api/visits",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_visits_ts_onRequestPost],
    },
  ]