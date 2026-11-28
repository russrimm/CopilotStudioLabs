// Preloaded by `npm test` (node --import): every test process reads the products a person added from its own empty file, so a
// product added on this computer (saved in the git-ignored portal/data) can never change what the shipped-catalog tests see,
// and tests that add products cannot disturb one another. A test that sets LAB_BUILDER_USER_PRODUCTS itself keeps its own value.
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LAB_BUILDER_USER_PRODUCTS) process.env.LAB_BUILDER_USER_PRODUCTS = join(tmpdir(), `lab-builder-test-user-products-${process.pid}.json`);
