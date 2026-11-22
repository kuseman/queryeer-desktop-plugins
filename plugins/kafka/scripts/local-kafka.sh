#!/usr/bin/env sh
# A local single-node Kafka (KRaft, no ZooKeeper) for trying the Kafka plugin.
#
#   plugins/kafka/scripts/local-kafka.sh start   # create or restart the container, wait until it answers
#   plugins/kafka/scripts/local-kafka.sh seed    # create the sample topics, messages and a consumer group
#   plugins/kafka/scripts/local-kafka.sh status  # topics, consumer groups
#   plugins/kafka/scripts/local-kafka.sh stop    # stop, keep the data
#   plugins/kafka/scripts/local-kafka.sh rm      # remove the container and its data
#
# Connect Queryeer with bootstrap servers localhost:9092 and security protocol PLAINTEXT.
# Override with KAFKA_CONTAINER, KAFKA_IMAGE and KAFKA_PORT.
set -eu

CONTAINER="${KAFKA_CONTAINER:-qkafka}"
IMAGE="${KAFKA_IMAGE:-apache/kafka:3.7.0}"
PORT="${KAFKA_PORT:-9092}"
BIN=/opt/kafka/bin
# Git Bash on Windows would rewrite /opt/... into a Windows path
export MSYS_NO_PATHCONV=1

kexec() {
  docker exec -i "$CONTAINER" "$@"
}

exists() {
  [ -n "$(docker ps -aq --filter "name=^${CONTAINER}$")" ]
}

running() {
  [ -n "$(docker ps -q --filter "name=^${CONTAINER}$")" ]
}

wait_ready() {
  printf 'Waiting for Kafka on localhost:%s' "$PORT"
  i=0
  while ! kexec $BIN/kafka-topics.sh --bootstrap-server localhost:9092 --list >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo ' timed out'
      docker logs --tail 30 "$CONTAINER"
      exit 1
    fi
    printf '.'
    sleep 1
  done
  echo ' ready'
}

start() {
  if running; then
    echo "$CONTAINER is already running"
  elif exists; then
    docker start "$CONTAINER" >/dev/null
  else
    # The image's defaults advertise localhost:9092; with another host port, advertise that one
    docker run -d --name "$CONTAINER" -p "${PORT}:9092" \
      -e KAFKA_NODE_ID=1 \
      -e KAFKA_PROCESS_ROLES=broker,controller \
      -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 \
      -e KAFKA_ADVERTISED_LISTENERS="PLAINTEXT://localhost:${PORT}" \
      -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
      -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
      -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
      -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
      -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
      "$IMAGE" >/dev/null
  fi
  wait_ready
}

create_topic() {
  kexec $BIN/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists \
    --topic "$1" --partitions "$2" --replication-factor 1 >/dev/null
}

seed() {
  running || start
  create_topic orders 3
  create_topic payments 1
  create_topic customers 2

  # orders: keys and headers ("headers<TAB>key<TAB>value")
  i=1
  while [ "$i" -le 30 ]; do
    status=created
    [ $((i % 3)) -eq 0 ] && status=shipped
    [ $((i % 7)) -eq 0 ] && status=cancelled
    printf 'source:web,trace:t-%s\tcustomer-%s\t{"orderId":%s,"customerId":"customer-%s","status":"%s","amount":%s.50,"items":[{"sku":"sku-%s","qty":%s}]}\n' \
      "$i" "$((i % 5))" "$i" "$((i % 5))" "$status" "$((i * 7 % 200))" "$((i % 9))" "$((i % 4 + 1))"
    i=$((i + 1))
  done | kexec $BIN/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders \
    --property parse.key=true --property parse.headers=true --property key.separator="$(printf '\t')" \
    --property headers.delimiter="$(printf '\t')" --property headers.separator=, --property headers.key.separator=:

  # payments: values only, no key
  i=1
  while [ "$i" -le 10 ]; do
    printf '{"paymentId":"p-%s","orderId":%s,"method":"%s","ok":%s}\n' \
      "$i" "$((i * 3))" "$([ $((i % 2)) -eq 0 ] && echo card || echo invoice)" "$([ $((i % 4)) -eq 0 ] && echo false || echo true)"
    i=$((i + 1))
  done | kexec $BIN/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic payments

  # customers: compaction-style keyed records, plain text values
  i=0
  while [ "$i" -lt 5 ]; do
    printf 'customer-%s|Customer %s\n' "$i" "$i"
    i=$((i + 1))
  done | kexec $BIN/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic customers \
    --property parse.key=true --property key.separator='|'

  # A consumer group with committed offsets, part way into orders, for later consumer browsing
  kexec $BIN/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders \
    --group billing --from-beginning --max-messages 12 --timeout-ms 15000 >/dev/null 2>&1 || true

  echo 'Seeded topics orders (30), payments (10), customers (5) and consumer group billing'
}

status() {
  running || { echo "$CONTAINER is not running"; exit 1; }
  echo '== Topics'
  kexec $BIN/kafka-topics.sh --bootstrap-server localhost:9092 --list
  echo '== Consumer groups'
  kexec $BIN/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --all-groups 2>/dev/null || true
}

case "${1:-}" in
  start) start ;;
  seed) seed ;;
  status) status ;;
  stop) docker stop "$CONTAINER" >/dev/null && echo "Stopped $CONTAINER" ;;
  rm) docker rm -f "$CONTAINER" >/dev/null && echo "Removed $CONTAINER" ;;
  *)
    echo "Usage: $0 start|seed|status|stop|rm" >&2
    exit 2
    ;;
esac
