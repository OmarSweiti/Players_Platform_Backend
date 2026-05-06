import { Injectable } from '@nestjs/common';
import { StorageService, UploadResult } from './storage.service';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LocalStorageService implements StorageService {
  private uploadPath: string;

  constructor() {
    this.uploadPath = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(this.uploadPath)) {
      fs.mkdirSync(this.uploadPath, { recursive: true });
    }
  }

  async upload(file: Express.Multer.File, folder: string): Promise<UploadResult> {
    const key = `${folder}/${uuidv4()}-${file.originalname}`;
    const filePath = path.join(this.uploadPath, key);
    
    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    
    // Write file
    await fs.promises.writeFile(filePath, file.buffer);
    
    return {
      url: `/uploads/${key}`,
      key,
    };
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.uploadPath, key);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  getUrl(key: string): string {
    return `/uploads/${key}`;
  }
}
