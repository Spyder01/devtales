# 🌙 Vicitales

Hi, I’m Suhan — and **Vicitales** is my personal space for stories, experiments, and ideas.

It began as a place to publish the worlds I write, but it has slowly grown into something more: a testing ground where I explore how modern publishing can live on fast, edge-native infrastructure.

Every chapter here is both a piece of fiction and a small step in an ongoing technical journey.

---

## ✍️ About Vicitales

I created Vicitales as a quiet home for stories that don’t fit inside social media timelines or algorithms. The stories here are serialized, evolving, and sometimes unfinished — much like the thoughts that created them.

At the same time, I use this project to experiment with web architecture and serverless systems before applying those ideas to larger platforms.

In many ways, Vicitales is both:

* 📖 a storytelling space
* 🧪 a living laboratory

---

## 🚀 Goals

With Vicitales, I aim to:

* create a calm, distraction-free reading experience
* publish serialized fiction and long-form writing
* learn and experiment with Cloudflare’s serverless ecosystem
* build reusable patterns for future publishing platforms

---

## 🏗️ Tech Stack

### Frontend

* **Astro**
* **AstroPaper** theme (beautiful minimal blog theme)
* Markdown content system
* Static-first architecture

### Cloudflare Platform (Experiments)

* Cloudflare Pages
* Workers (edge APIs)
* D1 (serverless SQL)
* KV (edge caching)
* Queues (background processing — planned)
* R2 (media storage — planned)

### Email (Planned)

* Resend for newsletter experimentation

---

## 🙏 Credits

Vicitales is built on top of the excellent **AstroPaper** theme created by its open-source contributors.

AstroPaper provides the clean typography, accessibility, and performance foundation that makes this reading experience possible. This project would not exist in its current form without their work.

---

## ⚡ Features

* Minimal, typography-focused design
* Chapter navigation (Previous / Next)
* Series-based storytelling
* RSS feed support
* Experimental edge analytics

  * visit tracking
  * scroll depth insights

---

## 🧪 Experimental Nature

Vicitales evolves continuously.
Some features exist purely for learning and experimentation:

* edge analytics pipelines
* serverless APIs
* publishing workflows at the edge
* performance experimentation

Not everything here is permanent — exploration is part of the project.

---

## 🛠️ Development

```bash
git clone https://github.com/spyder01/vicitales.git
cd vicitales
npm install
npm run dev
```

Open:

```
http://localhost:4321
```

---

## 🚢 Deployment

Vicitales is deployed using **Cloudflare Pages**, with automatic global deployments on every push.

---

## 📚 Content Structure

Stories are written in Markdown:

```
src/content/blog/
  red-lily/
    chapter-1.md
    chapter-2.md
```

Example frontmatter:

```md
---
title: Chapter One
series: Red Lily
chapter: 1
---
```

---

## 🌱 Future Plans

* Email newsletter
* Reader engagement dashboard
* Story collections & series pages
* Edge-powered publishing workflows
* Interactive storytelling experiments

---

## 👋 Author

**Suhan Bangera**

Vicitales is a small window into both my imagination and my curiosity about how stories — and software — evolve over time.

---

## 📜 License

Story content © Suhan Bangera
Code released under the MIT License unless stated otherwise.

---
