# Redis on Railway

Deploy the Redis-maintained Railway template in a dedicated project. The template includes Redis 8.2, persistent storage, a generated password, private networking and its provider-defined connection variables.

Choose your Railway workspace connection, enter an installation name, review the deployment, then install. Workbox Cloud retains the project identity for status, logs and confirmed removal. Removing the installation deletes its dedicated project and stored data. Changes made to the template upstream require a fresh catalog review before deployment.

This is Redis, a separate product from the native Valkey catalog entry. Redis 8 offers AGPLv3, RSALv2 and SSPLv1 licensing choices; select and comply with the applicable upstream license for your use. Workbox Cloud records the template source and configuration revision and does not redistribute the Redis image.

Source: [Redis Railway template](https://railway.com/deploy/redis). Licensing: [Redis licensing](https://redis.io/legal/licenses/).
