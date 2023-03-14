import { userInfo } from 'node:os';

/** Returns local username of the current user.  */
export const getUsername = () => {
    return userInfo().username;
}
