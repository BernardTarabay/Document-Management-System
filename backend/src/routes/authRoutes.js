const express = require("express");
const authController = require("../controllers/authController");
const { authenticate } = require("../middleware/authenticate");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

router.post("/register", asyncHandler(authController.register));
router.post("/login", asyncHandler(authController.login));
router.post("/refresh", asyncHandler(authController.refresh));
router.post("/logout", asyncHandler(authController.logout));
router.get("/me", authenticate, asyncHandler(authController.me));

module.exports = router;
