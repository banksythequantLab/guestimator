// Run: node worker/tests/accuracy_test.mjs
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as A from "../accuracy.js";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
ok("inside the range", A.verdict(40, 80, 60).tag === "in range" && A.verdict(40, 80, 60).ratio === 1);
ok("a little under still counts (10%)", A.verdict(40, 80, 37).tag === "in range");
ok("well under", A.verdict(40, 80, 20).tag === "sold below range");
ok("well over", A.verdict(40, 80, 120).tag === "sold above range" && A.verdict(40, 80, 120).ratio === 2);
ok("no estimate", A.verdict(0, 0, 50).tag === "no estimate");

const db = d1(join(here, "..", "migrations"));
const r = db.raw, now = new Date().toISOString(), rj = (lo, hi) => JSON.stringify({ identification: { name: "x" }, price_range: { low: lo, high: hi } });
r.prepare("INSERT INTO items (id,sale_id,name,price_cents,ai_title,created_at) VALUES ('i1','s','Lamp',0,'Brass lamp',?),('i2','s','Vase',0,'Blue vase',?),('i3','s','Clock',0,'Mantel clock',?)").run(now, now, now);
r.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES ('a1','i1','done',?,?),('a2','i2','done',?,?),('a3','i3','done',?,?)").run(rj(40, 80), now, rj(10, 20), now, rj(100, 150), now);
r.prepare("INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,total_cents,ship_paid_cents,status,ordered_at,created_at,updated_at) VALUES ('e1','o1','l1','u','i1',7500,1500,'FULFILLED',?,?,?)").run(now, now, now);
r.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,total_cents,status,created_at,updated_at) VALUES ('g1','s1','i2','acct','ship',4500,4500,'paid',?,?)").run(now, now);
r.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,total_cents,status,created_at,updated_at) VALUES ('g2','s1','i3','acct','ship',9900,9900,'cancelled',?,?)").run(now, now);
r.prepare("INSERT INTO estimate_ratings (appraisal_id,user_id,item_id,stars,created_at,updated_at) VALUES ('a1','u','i1',4,?,?)").run(now, now);
const rows = await A.accuracyRows(db), by = Object.fromEntries(rows.map(x => [x.item_id, x]));
ok("eBay sale less the shipping charged", by.i1 && by.i1.sold === 60 && by.i1.tag === "in range" && by.i1.stars === 4 && by.i1.name === "Brass lamp", by.i1);
ok("paid Market order counts, sold above", by.i2 && by.i2.sold === 45 && by.i2.tag === "sold above range", by.i2);
ok("cancelled order does not count", !by.i3);
r.prepare("INSERT INTO items (id,sale_id,name,price_cents,ai_title,created_at) VALUES ('i4','s','Ram',0,'32GB stick',?)").run(now);
r.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES ('a4','i4','done',?,?)").run(rj(100, 248), now);
r.prepare("INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,quantity,total_cents,ship_paid_cents,status,ordered_at,created_at,updated_at) VALUES ('e4','o4','l4','u','i4',7,68600,0,'FULFILLED',?,?,?)").run(now, now, now);
{ const q = (await A.accuracyRows(db)).find(x => x.item_id === "i4"); ok("multi-quantity eBay order is priced per piece", q && q.sold === 98 && q.tag === "in range", q); }
const S = A.summary(rows);
ok("summary", S.sold === 2 && S.priced === 2 && S.inRange === 1 && S.avgStars === 4 && S.rated === 1, S);
console.log("accuracy_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
