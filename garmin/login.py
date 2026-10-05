"""One-time Garmin Connect login. Run this yourself in a terminal.

Prompts for your email, password and (if enabled) MFA code, then saves
auth tokens to ~/.garminconnect so sync.py can run without your password.
"""

import getpass
from pathlib import Path

from garminconnect import Garmin

TOKENSTORE = Path("~/.garminconnect").expanduser()


def main() -> None:
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    TOKENSTORE.mkdir(mode=0o700, exist_ok=True)

    client = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    client.login(str(TOKENSTORE))
    client.client.dump(str(TOKENSTORE))

    print(f"\nLogged in as {client.get_full_name()}. Tokens saved to {TOKENSTORE}")
    print("You can now run: garmin/update.sh")


if __name__ == "__main__":
    main()
