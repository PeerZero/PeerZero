"""
CLI — command-line interface for the PeerZero Bot.

Commands:
  peerzero-bot run              Run the bot (School + platforms)
  peerzero-bot status           Show bot identity and status
  peerzero-bot add-platform     Add a platform to the config
"""

import sys
import logging

from .config import BotConfig
from .memory import MemoryManager, FileStorage, SqliteStorage
from .adapters.school import SchoolAdapter
from .adapters.a2a import A2AAdapter
from .adapters.webhook import WebhookAdapter
from .adapters.mcp import MCPAdapter, MCPServerConfig as MCPServerConfigAdapter
from .security import SecurityGateway, AuditLog, CredentialStore
from .reporting import PhoneHome
from .prompts import PromptBuilder
from .agent import PeerZeroBot
from .llm_client import LLMClient
from .identity import build_identity_summary
from .autonomy import AutonomyPolicy, AutonomyGate

logger = logging.getLogger("peerzero-bot")


def _setup_logging(level: str):
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def _build_bot(config: BotConfig) -> PeerZeroBot:
    """Wire up all components and return a ready-to-run bot."""
    # Credential store — isolates credentials per adapter
    cred_store = CredentialStore()

    # Security gateway
    gateway = SecurityGateway(school_url=config.school_url)

    # Audit log
    audit = None
    if config.audit_log:
        from pathlib import Path
        audit_dir = str(Path(config.memory_path) / "audit")
        audit = AuditLog(audit_dir)

    # Memory storage backend
    if config.memory_backend == "sqlite":
        storage = SqliteStorage(config.memory_path)
    else:
        storage = FileStorage(config.memory_path)
    memory = MemoryManager(storage)

    # LLM client (strong model — paper, review, bounty, revise)
    llm = LLMClient(
        provider=config.llm_provider,
        model=config.llm_model,
        api_key=config.llm_api_key,
        max_tokens=config.max_llm_tokens,
    )

    # Fast LLM client (optional — condensers, platform actions, identity reflection)
    llm_fast = None
    if config.llm_fast_model:
        llm_fast = LLMClient(
            provider=config.llm_fast_provider or config.llm_provider,
            model=config.llm_fast_model,
            api_key=config.llm_fast_api_key or config.llm_api_key,
            max_tokens=config.max_llm_tokens,
        )

    # School adapter
    school = SchoolAdapter(
        school_url=config.school_url,
        api_key=config.school_api_key,
        gateway=gateway,
        credential_store=cred_store,
    )

    # Prompt builder
    prompts = PromptBuilder(memory)

    # Phone home reporting
    phone_home = None
    if config.phone_home and config.peerzero_app_token:
        phone_home = PhoneHome(
            app_url=config.peerzero_app_url,
            app_token=config.peerzero_app_token,
            bot_handle=config.handle,
            gateway=gateway,
        )

    # Autonomy gate
    autonomy_policy = AutonomyPolicy(
        level=config.autonomy_level,
        allowed_actions=config.autonomy_allowed_actions,
        blocked_actions=config.autonomy_blocked_actions,
        allowed_platforms=config.autonomy_allowed_platforms,
        blocked_platforms=config.autonomy_blocked_platforms,
        allowed_tools=config.autonomy_allowed_tools,
        blocked_tools=config.autonomy_blocked_tools,
        max_actions_per_cycle=config.autonomy_max_actions_per_cycle,
        max_tool_calls_per_cycle=config.autonomy_max_tool_calls_per_cycle,
        max_content_length=config.autonomy_max_content_length,
        blocked_content_patterns=config.autonomy_blocked_content_patterns,
        can_submit_papers=config.autonomy_can_submit_papers,
        can_submit_reviews=config.autonomy_can_submit_reviews,
        can_file_bounties=config.autonomy_can_file_bounties,
        can_revise_papers=config.autonomy_can_revise_papers,
    )
    policy_errors = autonomy_policy.validate()
    if policy_errors:
        for e in policy_errors:
            logger.warning(f"[AUTONOMY] Policy error: {e}")
    autonomy_gate = AutonomyGate(autonomy_policy)

    # Platform adapters
    platform_adapters = []
    for pc in config.platforms:
        if not pc.enabled:
            continue
        api_key = pc.api_key
        if pc.adapter == "a2a":
            adapter = A2AAdapter(
                platform_name=pc.name,
                platform_url=pc.url,
                agent_card_url=pc.agent_card_url,
                api_key=api_key,
                gateway=gateway,
                credential_store=cred_store,
            )
        elif pc.adapter == "webhook":
            adapter = WebhookAdapter(
                platform_name=pc.name,
                platform_url=pc.url,
                api_key=api_key,
                gateway=gateway,
                events=pc.events,
                credential_store=cred_store,
            )
        elif pc.adapter == "mcp":
            # Convert config MCPServerConfigs to adapter MCPServerConfigs
            mcp_servers = [
                MCPServerConfigAdapter(
                    name=srv.name,
                    command=srv.command,
                    args=srv.args,
                    env=srv.env,
                    transport=srv.transport,
                    url=srv.url,
                )
                for srv in pc.mcp_servers
            ]
            adapter = MCPAdapter(
                platform_name=pc.name,
                servers=mcp_servers,
                defer_loading=pc.mcp_defer_loading,
                max_tools_in_context=pc.mcp_max_tools,
            )
        else:
            logger.warning(f"Unknown adapter type '{pc.adapter}' for platform '{pc.name}'")
            continue
        platform_adapters.append(adapter)

    return PeerZeroBot(
        config=config,
        memory=memory,
        school=school,
        llm=llm,
        prompts=prompts,
        gateway=gateway,
        audit=audit,
        phone_home=phone_home,
        platform_adapters=platform_adapters,
        llm_fast=llm_fast,
        autonomy_gate=autonomy_gate,
    )


def cmd_run(config: BotConfig):
    """Run the bot."""
    bot = _build_bot(config)
    bot.run()


def cmd_status(config: BotConfig):
    """Show bot identity and status."""
    gateway = SecurityGateway(school_url=config.school_url)
    school = SchoolAdapter(
        school_url=config.school_url,
        api_key=config.school_api_key,
        gateway=gateway,
    )

    print("Fetching profile from School...\n")
    try:
        portable = school.get_portable_profile()
        print("Bot Identity:")
        print(build_identity_summary(portable))

        # Show platform configs
        if config.platforms:
            print(f"\nConfigured platforms ({len(config.platforms)}):")
            for pc in config.platforms:
                status = "enabled" if pc.enabled else "disabled"
                print(f"  - {pc.name} ({pc.adapter}) [{status}] → {pc.url}")
        else:
            print("\nNo platforms configured.")

        print(f"\nMemory: {config.memory_path}")
        print(f"Memory backend: {config.memory_backend}")

    except Exception as e:
        print(f"Failed to fetch profile: {e}")
        print("Make sure PEERZERO_API_KEY is set and the School is reachable.")


def cmd_add_platform(config: BotConfig, args: list[str]):
    """Guide user through adding a platform to their config."""
    if not args:
        print("Usage: peerzero-bot add-platform <name>")
        print("Example: peerzero-bot add-platform moltbook")
        return

    name = args[0]
    print(f"\nAdding platform: {name}")
    print(f"Set the API key as an environment variable:")
    print(f"  export {name.upper()}_API_KEY=\"your-key-here\"")
    print(f"\nAdd this to your peerzero_bot.toml:")
    print(f"""
[platforms.{name}]
enabled = true
adapter = "a2a"
url = "https://api.{name}.com"
agent_card_url = "https://api.{name}.com/.well-known/agent-card.json"
heartbeat_interval = 3600
""")
    print("Then run: peerzero-bot run")


def main():
    """CLI entry point."""
    args = sys.argv[1:]

    if not args or args[0] in ("--help", "-h"):
        print("PeerZero Bot — Exportable autonomous reasoning agent")
        print()
        print("Commands:")
        print("  run              Run the bot (School + platforms)")
        print("  status           Show bot identity and status")
        print("  add-platform     Add a platform to config")
        print()
        print("Quick start:")
        print("  export PEERZERO_API_KEY='pz_...'")
        print("  export LLM_API_KEY='sk-ant-...'")
        print("  peerzero-bot run")
        return

    command = args[0]

    # Find config file
    config_path = None
    for i, arg in enumerate(args):
        if arg in ("--config", "-c") and i + 1 < len(args):
            config_path = args[i + 1]
            break

    config = BotConfig.load(config_path)
    errors = config.validate()
    if errors:
        for e in errors:
            print(f"[CONFIG ERROR] {e}")
        print("\nFix the errors above and try again.")
        sys.exit(1)

    _setup_logging(config.log_level)
    config.ensure_directories()

    if command == "run":
        cmd_run(config)
    elif command == "status":
        cmd_status(config)
    elif command == "add-platform":
        cmd_add_platform(config, args[1:])
    else:
        print(f"Unknown command: {command}")
        print("Run 'peerzero-bot --help' for usage.")
        sys.exit(1)


if __name__ == "__main__":
    main()
