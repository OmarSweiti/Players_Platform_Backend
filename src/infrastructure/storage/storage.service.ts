import { Injectable } from '@nestjs/common';

export interface UploadResult {
  url: string;
  key: string;
}

/** An uploaded file — as much of it as storage needs. */
export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
}

@Injectable()
export abstract class StorageService {
  abstract upload(file: UploadedFile, folder: string): Promise<UploadResult>;
  abstract delete(key: string): Promise<void>;
  abstract getUrl(key: string): string;
}
