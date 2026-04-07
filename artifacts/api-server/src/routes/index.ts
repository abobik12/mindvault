import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import foldersRouter from "./folders";
import itemsRouter from "./items";
import geminiRouter from "./gemini";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(foldersRouter);
router.use(itemsRouter);
router.use(geminiRouter);

export default router;
