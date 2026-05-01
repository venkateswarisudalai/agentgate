// Small bundled lists of the most-downloaded packages per ecosystem.
// Used as the haystack for typosquat detection: if a candidate is within
// edit distance 1–2 of one of these AND the candidate itself is not on
// the list, it's a likely typosquat.
//
// Kept short on purpose — covers the highest-impact typosquat targets.
// Larger lists can be loaded at runtime if needed; v0 stays bundled.

export const NPM_TOP: readonly string[] = [
  "react", "react-dom", "lodash", "axios", "express", "next", "vue",
  "typescript", "webpack", "babel", "eslint", "prettier", "jest",
  "vitest", "rxjs", "moment", "dayjs", "uuid", "chalk", "commander",
  "yargs", "dotenv", "cors", "body-parser", "mongoose", "sequelize",
  "prisma", "knex", "pg", "mysql2", "redis", "ioredis", "bcrypt",
  "jsonwebtoken", "passport", "socket.io", "ws", "node-fetch", "got",
  "request", "underscore", "ramda", "immer", "zustand", "redux",
  "react-router", "react-router-dom", "styled-components", "tailwindcss",
  "postcss", "autoprefixer", "sass", "less", "rollup", "vite", "esbuild",
  "tsx", "ts-node", "nodemon", "pm2", "winston", "pino", "morgan",
  "debug", "chalk", "colors", "kleur", "picocolors", "fastify", "koa",
  "hapi", "nestjs", "graphql", "apollo-server", "type-orm", "mongodb",
  "openai", "anthropic", "langchain", "zod", "yup", "joi", "ajv",
  "minimist", "glob", "rimraf", "cross-env", "concurrently", "husky",
  "lint-staged", "semver", "tar", "node-sass", "sharp", "puppeteer",
  "playwright", "cypress", "react-native", "expo",
];

export const PYPI_TOP: readonly string[] = [
  "requests", "urllib3", "boto3", "botocore", "setuptools", "certifi",
  "charset-normalizer", "idna", "numpy", "pandas", "scipy", "matplotlib",
  "scikit-learn", "tensorflow", "torch", "transformers", "huggingface-hub",
  "openai", "anthropic", "langchain", "langgraph", "tiktoken", "pydantic",
  "fastapi", "uvicorn", "starlette", "flask", "django", "sqlalchemy",
  "alembic", "psycopg2", "psycopg2-binary", "pymongo", "redis", "celery",
  "pytest", "black", "ruff", "mypy", "pyright", "isort", "flake8",
  "tox", "coverage", "click", "typer", "rich", "tqdm", "loguru",
  "pyyaml", "toml", "tomli", "jinja2", "markupsafe", "beautifulsoup4",
  "lxml", "selenium", "playwright", "httpx", "aiohttp", "aiofiles",
  "asyncio", "asyncpg", "websockets", "grpcio", "protobuf", "kafka-python",
  "confluent-kafka", "google-cloud-storage", "azure-storage-blob",
  "snowflake-connector-python", "duckdb", "polars", "pyarrow", "ray",
  "mlflow", "wandb", "pytest-cov", "pytest-asyncio", "freezegun",
  "factory-boy", "faker", "responses", "vcrpy", "pillow", "opencv-python",
  "pyjwt", "cryptography", "bcrypt", "passlib", "python-dotenv",
  "python-dateutil", "pytz", "six", "wheel", "pip", "poetry",
];
