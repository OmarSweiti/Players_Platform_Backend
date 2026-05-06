import { Injectable } from '@nestjs/common';

export interface UploadResult {
  url: string;
  key: string;
}

@Injectable()
export abstract class StorageService {
  abstract upload(file: Express.Multer.File, folder: string): Promise<UploadResult>;
  abstract delete(key: string): Promise<void>;
  abstract getUrl(key: string): string;
}
