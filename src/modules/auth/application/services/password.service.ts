import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  private readonly argon2Config = {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3, // 3 iterations
    parallelism: 1, // 1 thread
  };

  /**
   * Hash password using Argon2id
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, this.argon2Config);
  }

  /**
   * Verify password against hash
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      return false;
    }
  }
}
