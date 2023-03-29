bring cloud;

let bucket = new cloud.Bucket();
let queue = new cloud.Queue();
let api = new cloud.Api();

api.get("/test-get", inflight (req: cloud.ApiRequest): cloud.ApiResponse => {
  return cloud.ApiResponse {
    status: 200,
    body: {
      query: Json (Json req).get("query"),
    }
  };
});
api.post("/test-post", inflight (req: cloud.ApiRequest): cloud.ApiResponse => {
  return cloud.ApiResponse {
    status: 200,
    body: "Hello, POST!"
  };
});

let handler = inflight (message: str): str => {
  bucket.put("hello.txt", "Hello, ${message}!");
  log("Hello, ${message}!");
  return message;
};

queue.on_message(handler);

let counter = new cloud.Counter(initial: 0);
new cloud.Function(inflight (message: str): str => {
  counter.inc();
  log("Counter is now ${counter.inc(0)}");
  return message;
}) as "IncrementCounter";

let topic = new cloud.Topic() as "Topic";
topic.on_message(inflight (message: str): str => {
  log("Topic subscriber #1: ${message}");
  return message;
});
topic.on_message(inflight (message: str): str => {
  log("Topic subscriber #2: ${message}");
  return message;
});

new cloud.Function(inflight (message: str) => {
  let value = counter.inc();
  log("Counter is now ${counter.inc(0)}");
  assert(value == 1);
}) as "test: Increment counter";

new cloud.Function(inflight (message: str) => {
 queue.push("hey");
}) as "test: Push message to the queue";

new cloud.Function(inflight (message: str) => {
  log("Hello World!");
  assert(true);
}) as "test: Log";
