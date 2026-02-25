FROM rust:1.93 AS builder

WORKDIR /app

COPY Cargo.* .
COPY api api

RUN cargo build -p api --release

FROM debian:stable-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/api /app/api

ENV RUST_LOG=info

EXPOSE 8080

CMD ["/app/api"]

