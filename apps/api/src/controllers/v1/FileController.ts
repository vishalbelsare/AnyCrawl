import { Response } from "express";
import { z } from "zod";
import { RequestWithAuth } from "@anycrawl/libs";
import { s3 } from "@anycrawl/libs";
import { Utils } from "@anycrawl/scrape/Utils";
import { basename, join, resolve } from 'path';

const pathSchema = z.object({
    path: z.string().min(1, "Path is required")
});

export class FileController {
    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { path } = pathSchema.parse({ path: req.params.path });
            if (process.env.ANYCRAWL_STORAGE === 's3') {
                const url = await s3.getTemporaryUrl(path);
                res.redirect(url);
            } else {
                const utils = Utils.getInstance();
                if (path === "." || path === ".." || path.includes("/") || path.includes("\\") || basename(path) !== path) {
                    res.status(400).json({ error: 'Invalid path' });
                    return;
                }

                const storageRoot = resolve(process.env.ANYCRAWL_LOCAL_STORAGE_DIR || join(process.cwd(), '..', '..', 'storage'));
                const filePath = join(storageRoot, 'key_value_stores', utils.getStorageName(), path);
                res.sendFile(filePath, (err) => {
                    if (err) {
                        console.error('Error sending file:', err);
                        res.status(500).json({ error: 'Error sending file', message: err.message });
                    }
                });
            }
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({
                    error: 'Invalid path',
                    details: error.errors
                });
                return;
            }

            console.error('Error processing request:', error);
            res.status(500).json({
                error: 'Failed to process path',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    };
}
